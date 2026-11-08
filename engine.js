/* ENGINE START — pure analysis code, no DOM. Tested in node. */
const Engine = (() => {
  const RE = 6371008.8, DEG = Math.PI / 180;
  const CFG = {
    denseDt: 30,          // s: a step this short counts as continuous (LIVE) tracking
    minSessionDur: 60,    // s
    minSessionPts: 8,
    mergeGap: 180,        // s: activity pieces closer than this are merged
    gapDt: 45 * 60,       // s: longer silence = no data
    homeR: 100,           // m: radius around the main resting place
    restV: 0.3,           // m/s: below this the dog is standing still
    vehicleV: 9, vehicleSustain: 30, vehicleHard: 20, sparseVehicleV: 6,
    sparseJitter: 35,     // m: sparse steps shorter than this are GPS drift
    anchor: 2,            // m: dense-track hysteresis against jitter
    pauseMin: 10,         // s
  };
  const ZONES = [
    { id: 'rest',   name: '休息', min: 0 },
    { id: 'walk',   name: '慢走', min: 0.3 },
    { id: 'brisk',  name: '快走', min: 1.0 },
    { id: 'trot',   name: '小跑', min: 2.0 },
    { id: 'sprint', name: '冲刺', min: 3.5 },
  ];
  const zoneOf = v => { let z = 0; for (let i = 1; i < ZONES.length; i++) if (v >= ZONES[i].min) z = i; return z; };

  // ---------- parsing ----------
  const reCache = {};
  const tagRe = k => reCache[k] || (reCache[k] = new RegExp('<(?:[\\w-]+:)?' + k + '\\b[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?' + k + '>'));
  const attrRe = k => reCache['@' + k] || (reCache['@' + k] = new RegExp('\\b' + k + '\\s*=\\s*["\']([^"\']+)["\']'));
  const tag = (s, k) => { const m = tagRe(k).exec(s); return m ? m[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim() : null; };
  const attr = (s, k) => { const m = attrRe(k).exec(s); return m ? parseFloat(m[1]) : NaN; };

  function parseGPX(text) {
    const points = [];
    const re = /<(?:[\w-]+:)?(trkpt|rtept)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:[\w-]+:)?\1>)/g;
    let m;
    while ((m = re.exec(text))) {
      const a = m[2], body = m[3] || '';
      const lat = attr(a, 'lat'), lon = attr(a, 'lon');
      if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
      const time = tag(body, 'time');
      const t = time ? Date.parse(time) : NaN;
      if (!isFinite(t)) continue;
      const e = parseFloat(tag(body, 'ele'));
      let spd = null;
      const c = tag(body, 'cmt') || tag(body, 'desc');
      if (c) { const mm = /speed\s*[:=]\s*(-?[\d.]+)/i.exec(c); if (mm) spd = +mm[1]; }
      if (spd == null) { const s2 = parseFloat(tag(body, 'speed')); if (isFinite(s2)) spd = s2; }
      points.push({ t, lat, lon, ele: isFinite(e) ? e : null, spd });
    }
    const head = text.slice(0, 4000);
    return { name: tag(head, 'name'), creator: (/creator\s*=\s*"([^"]*)"/.exec(head) || [])[1] || null, points };
  }

  // sort, de-duplicate timestamps, drop single-point GPS spikes
  function clean(points) {
    const p = points.slice().sort((a, b) => a.t - b.t);
    const out = [];
    for (const q of p) if (!out.length || q.t !== out[out.length - 1].t) out.push(q);
    if (out.length < 3) return out;
    const keep = [out[0]];
    for (let i = 1; i < out.length - 1; i++) {
      const a = keep[keep.length - 1], b = out[i], c = out[i + 1];
      const t1 = (b.t - a.t) / 1000, t2 = (c.t - b.t) / 1000;
      const v1 = hav(a, b) / t1, v2 = hav(b, c) / t2;
      if (v1 > 40 && v2 > 40 && hav(a, c) < hav(a, b) * 0.3) continue; // out-and-back spike
      keep.push(b);
    }
    keep.push(out[out.length - 1]);
    return keep;
  }

  function hav(a, b) {
    const p1 = a.lat * DEG, p2 = b.lat * DEG, dp = p2 - p1, dl = (b.lon - a.lon) * DEG;
    const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
    return 2 * RE * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  function projector(lat0, lon0) {
    const kx = DEG * RE * Math.cos(lat0 * DEG), ky = DEG * RE;
    return {
      fwd: p => ({ x: (p.lon - lon0) * kx, y: (p.lat - lat0) * ky }),
      inv: (x, y) => ({ lat: lat0 + y / ky, lon: lon0 + x / kx }),
    };
  }
  const median = a => { if (!a.length) return NaN; const s = a.slice().sort((x, y) => x - y), h = s.length >> 1; return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };

  // ---------- one continuous track (an activity) ----------
  function analyzeTrack(pts) {
    const n = pts.length;
    const P = projector(pts[0].lat, pts[0].lon);
    const raw = pts.map(P.fwd);
    const t = pts.map(p => p.t / 1000);
    const dts = []; for (let i = 1; i < n; i++) dts.push(t[i] - t[i - 1]);
    const denseDts = dts.filter(d => d <= CFG.denseDt);

    // time-based gaussian smoothing, only across dense neighbours
    const sm = raw.map((p, i) => {
      const local = [i > 0 ? t[i] - t[i - 1] : Infinity, i < n - 1 ? t[i + 1] - t[i] : Infinity].filter(d => d <= CFG.denseDt);
      if (!local.length) return { x: p.x, y: p.y };
      const sig = Math.min(6, Math.max(2, Math.min(...local)));
      let W = 0, X = 0, Y = 0;
      for (let dir = -1; dir <= 1; dir += 2) {
        for (let j = dir < 0 ? i : i + 1; j >= 0 && j < n; j += dir) {
          const dt = t[j] - t[i];
          if (Math.abs(dt) > 3 * sig) break;
          if (j !== i && Math.abs(t[j] - t[j - dir]) > CFG.denseDt) break; // don't smooth across a sparse gap
          const w = Math.exp(-dt * dt / (2 * sig * sig));
          W += w; X += w * raw[j].x; Y += w * raw[j].y;
        }
      }
      return { x: X / W, y: Y / W };
    });
    const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

    // per-point speed (dense: central difference on the smoothed track)
    const v = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      const okL = i > 0 && t[i] - t[i - 1] <= CFG.denseDt, okR = i < n - 1 && t[i + 1] - t[i] <= CFG.denseDt;
      const a = okL ? i - 1 : i, b = okR ? i + 1 : i;
      v[i] = b > a ? dist(sm[a], sm[b]) / (t[b] - t[a]) : NaN;
    }

    // steps
    const steps = [];
    for (let i = 1; i < n; i++) {
      const dt = t[i] - t[i - 1];
      const dense = dt <= CFG.denseDt;
      const d = dist(sm[i - 1], sm[i]);
      let sv;
      if (dense) sv = ((isFinite(v[i - 1]) ? v[i - 1] : 0) + (isFinite(v[i]) ? v[i] : 0)) / 2;
      else sv = (d < CFG.sparseJitter ? 0 : d) / dt;
      steps.push({ i, dt, dense, d, v: sv, gap: dt > CFG.gapDt, vehicle: false });
    }
    // vehicle detection
    for (let k = 0; k < steps.length; k++) {
      const s = steps[k];
      if (s.v > CFG.vehicleHard || (!s.dense && !s.gap && s.v > CFG.sparseVehicleV)) s.vehicle = true;
    }
    for (let k = 0; k < steps.length;) {
      if (steps[k].dense && steps[k].v > CFG.vehicleV) {
        let j = k, dur = 0;
        while (j < steps.length && steps[j].dense && steps[j].v > CFG.vehicleV * 0.6) { dur += steps[j].dt; j++; }
        if (dur >= CFG.vehicleSustain) for (let q = k; q < j; q++) steps[q].vehicle = true;
        k = Math.max(j, k + 1);
      } else k++;
    }

    // distance with anchor hysteresis
    const cum = new Array(n).fill(0);
    let total = 0, vehDist = 0, anchor = sm[0];
    for (const s of steps) {
      const p = sm[s.i];
      if (s.gap) { anchor = p; }
      else if (s.vehicle) { vehDist += s.d; anchor = p; }
      else if (s.dense) { const dd = dist(anchor, p); if (dd >= CFG.anchor) { total += dd; anchor = p; } }
      else { if (s.d >= CFG.sparseJitter) total += s.d; anchor = p; }
      cum[s.i] = total;
    }

    // zones, moving time, pauses
    const zoneTime = ZONES.map(() => 0);
    let moving = 0, vehTime = 0, gapTime = 0;
    for (const s of steps) {
      if (s.gap) { gapTime += s.dt; s.zone = -1; continue; }
      if (s.vehicle) { vehTime += s.dt; s.zone = -2; continue; }
      s.zone = zoneOf(s.v);
      zoneTime[s.zone] += s.dt;
      if (s.zone > 0) moving += s.dt;
    }
    const pauses = [];
    const firstMove = steps.findIndex(s => s.zone > 0);
    let lastMove = -1; for (let k = steps.length - 1; k >= 0; k--) if (steps[k].zone > 0) { lastMove = k; break; }
    for (let k = firstMove; k >= 0 && k <= lastMove;) {
      if (steps[k].zone === 0 && steps[k].dense) {
        let j = k, dur = 0;
        while (j <= lastMove && steps[j].zone === 0 && steps[j].dense) { dur += steps[j].dt; j++; }
        if (dur >= CFG.pauseMin) {
          let X = 0, Y = 0, c = 0;
          for (let q = steps[k].i - 1; q <= steps[j - 1].i; q++) { X += sm[q].x; Y += sm[q].y; c++; }
          const ll = P.inv(X / c, Y / c);
          pauses.push({ t0: t[steps[k].i - 1] * 1000, t1: t[steps[j - 1].i] * 1000, dur, lat: ll.lat, lon: ll.lon });
        }
        k = j;
      } else k++;
    }

    // max speed (dog only)
    let maxV = 0, maxAt = null;
    const vehPoint = new Array(n).fill(false);
    for (const s of steps) if (s.vehicle) { vehPoint[s.i] = vehPoint[s.i - 1] = true; }
    for (let i = 0; i < n; i++) if (!vehPoint[i] && isFinite(v[i]) && v[i] > maxV) { maxV = v[i]; maxAt = pts[i].t; }
    if (!denseDts.length) for (const s of steps) if (!s.vehicle && !s.gap && s.v > maxV) { maxV = s.v; maxAt = pts[s.i].t; }

    // elevation (GPS altitude is noisy: median filter + 5 m hysteresis)
    let elev = null;
    const eleN = pts.filter(p => p.ele != null).length;
    const eleS = new Array(n).fill(null);
    if (eleN >= n * 0.5 && n >= 5) {
      for (let i = 0; i < n; i++) {
        const w = [];
        for (let j = Math.max(0, i - 4); j <= Math.min(n - 1, i + 4); j++) if (pts[j].ele != null && Math.abs(t[j] - t[i]) <= 60) w.push(pts[j].ele);
        eleS[i] = w.length ? median(w) : null;
      }
      let gain = 0, loss = 0, ref = null, mn = Infinity, mx = -Infinity;
      for (const e of eleS) {
        if (e == null) continue;
        mn = Math.min(mn, e); mx = Math.max(mx, e);
        if (ref == null) ref = e;
        else if (e - ref >= 5) { gain += e - ref; ref = e; }
        else if (ref - e >= 5) { loss += ref - e; ref = e; }
      }
      elev = { gain, loss, min: mn, max: mx };
    }

    // splits
    const L = total < 1000 ? 100 : total < 4000 ? 500 : 1000;
    const splits = [];
    const timeAtDist = target => {
      for (let i = 1; i < n; i++) if (cum[i] >= target) {
        const d0 = cum[i - 1], d1 = cum[i];
        const f = d1 > d0 ? (target - d0) / (d1 - d0) : 1;
        return t[i - 1] + f * (t[i] - t[i - 1]);
      }
      return null;
    };
    let prevT = t[0];
    const firstMoveT = firstMove >= 0 ? t[steps[firstMove].i - 1] : t[0];
    prevT = firstMoveT;
    for (let k = 1; k * L <= total + 1e-6; k++) {
      const tt = timeAtDist(k * L);
      if (tt == null) break;
      splits.push({ k, dist: L, dur: tt - prevT, partial: false }); prevT = tt;
    }
    const rem = total - splits.length * L;
    const lastMoveT = lastMove >= 0 ? t[steps[lastMove].i] : t[n - 1];
    if (rem >= L * 0.2 && lastMoveT > prevT) splits.push({ k: splits.length + 1, dist: rem, dur: lastMoveT - prevT, partial: true });

    // samples for charts & map
    const samples = pts.map((p, i) => {
      const ll = P.inv(sm[i].x, sm[i].y);
      const st = i > 0 ? steps[i - 1] : steps[0];
      return {
        t: p.t, lat: ll.lat, lon: ll.lon, rawLat: p.lat, rawLon: p.lon,
        v: isFinite(v[i]) && st && st.dense ? v[i] : (st ? st.v : 0),
        zone: st ? st.zone : 0, dense: st ? st.dense : false,
        vehicle: vehPoint[i], d: cum[i], ele: eleS[i], spd: p.spd,
      };
    });
    const denseShare = steps.length ? steps.filter(s => s.dense).reduce((a, s) => a + s.dt, 0) / Math.max(1, t[n - 1] - t[0]) : 0;

    return {
      start: pts[0].t, end: pts[n - 1].t, duration: t[n - 1] - t[0], n,
      medianDt: median(dts), denseMedianDt: median(denseDts), denseShare,
      distance: total, movingTime: moving, avgMoving: moving > 0 ? total / moving : 0,
      maxV, maxAt, zoneTime, vehicleTime: vehTime, vehicleDist: vehDist, gapTime,
      pauses, splits, splitLen: L, elev, samples,
      rawDistance: pts.reduce((a, p, i) => i ? a + hav(pts[i - 1], p) : 0, 0),
    };
  }

  // ---------- main resting place ----------
  function findHome(points) {
    if (!points.length) return null;
    const P = projector(points[0].lat, points[0].lon);
    const xy = points.map(P.fwd);
    const w = points.map((p, i) => i < points.length - 1 ? Math.min((points[i + 1].t - p.t) / 1000, 1800) : 60);
    const cell = 50, grid = new Map();
    xy.forEach((q, i) => { const k = Math.floor(q.x / cell) + ',' + Math.floor(q.y / cell); grid.set(k, (grid.get(k) || 0) + w[i]); });
    let best = null, bw = -1;
    for (const [k] of grid) {
      const [gx, gy] = k.split(',').map(Number); let s = 0;
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) s += grid.get((gx + dx) + ',' + (gy + dy)) || 0;
      if (s > bw) { bw = s; best = { x: (gx + 0.5) * cell, y: (gy + 0.5) * cell }; }
    }
    for (let it = 0; it < 4; it++) {
      let X = 0, Y = 0, W = 0;
      xy.forEach((q, i) => { if (Math.hypot(q.x - best.x, q.y - best.y) <= CFG.homeR) { X += q.x * w[i]; Y += q.y * w[i]; W += w[i]; } });
      if (W) best = { x: X / W, y: Y / W };
    }
    const ll = P.inv(best.x, best.y);
    let W = 0, inW = 0;
    xy.forEach((q, i) => { W += w[i]; if (Math.hypot(q.x - best.x, q.y - best.y) <= CFG.homeR) inW += w[i]; });
    return { lat: ll.lat, lon: ll.lon, r: CFG.homeR, share: W ? inW / W : 0 };
  }

  // ---------- whole data set ----------
  function analyzeAll(points) {
    const pts = clean(points);
    const n = pts.length;
    if (n < 2) return { points: pts, home: null, blocks: [], activities: [] };
    const home = findHome(pts);
    const away = pts.map(p => hav(p, home) > CFG.homeR);
    const dt = i => (pts[i + 1].t - pts[i].t) / 1000;

    // dense sessions (index ranges)
    const ranges = [];
    for (let i = 0; i < n - 1;) {
      if (dt(i) <= CFG.denseDt) {
        let j = i; while (j < n - 1 && dt(j) <= CFG.denseDt) j++;
        if ((pts[j].t - pts[i].t) / 1000 >= CFG.minSessionDur && j - i + 1 >= CFG.minSessionPts) ranges.push({ a: i, b: j, live: true });
        i = j;
      } else i++;
    }
    const inLive = new Array(n).fill(false);
    ranges.forEach(r => { for (let k = r.a; k <= r.b; k++) inLive[k] = true; });

    // sparse excursions away from the resting place
    for (let i = 0; i < n;) {
      if (away[i] && !inLive[i]) {
        let j = i; while (j + 1 < n && away[j + 1]) j++;
        const far = Math.max(...pts.slice(i, j + 1).map(p => hav(p, home)));
        if (j > i || far > CFG.homeR * 2.5) ranges.push({ a: Math.max(0, i - 1), b: Math.min(n - 1, j + 1), live: false });
        i = j + 1;
      } else i++;
    }
    ranges.sort((x, y) => x.a - y.a);
    const merged = [];
    for (const r of ranges) {
      const last = merged[merged.length - 1];
      if (last && (r.a <= last.b || (pts[r.a].t - pts[last.b].t) / 1000 <= CFG.mergeGap)) { last.b = Math.max(last.b, r.b); last.live = last.live || r.live; }
      else merged.push({ ...r });
    }
    const activities = [];
    for (const r of merged) {
      const slice = pts.slice(r.a, r.b + 1);
      if (slice.length < 2) continue;
      const a = analyzeTrack(slice);
      if (a.distance < 30 && a.movingTime < 60) continue;
      a.live = r.live; a.idx = [r.a, r.b];
      activities.push(a);
    }

    // timeline blocks
    const actAt = new Array(n).fill(null);
    activities.forEach(a => { a.samples.forEach((s, k) => { actAt[a.idx[0] + k] = { a, k }; }); });
    const blocks = [];
    for (let i = 0; i < n - 1; i++) {
      const d = dt(i);
      let state;
      if (d > CFG.gapDt) state = 'gap';
      else if (actAt[i] && actAt[i + 1] && actAt[i].a === actAt[i + 1].a && actAt[i + 1].a.live && d <= CFG.denseDt) {
        const z = actAt[i + 1].a.samples[actAt[i + 1].k].zone;
        state = z === -2 ? 'vehicle' : z > 0 ? 'move' : 'pause';
      } else if (actAt[i] && actAt[i + 1] && actAt[i].a === actAt[i + 1].a && !actAt[i].a.live) {
        const z = actAt[i + 1].a.samples[actAt[i + 1].k].zone;
        state = z === -2 ? 'vehicle' : 'away';
      } else state = away[i] || away[i + 1] ? 'away' : 'home';
      const t0 = pts[i].t, t1 = pts[i + 1].t, aw = state !== 'gap' && (away[i] || away[i + 1]);
      const last = blocks[blocks.length - 1];
      if (last && last.state === state && last.aw === aw && last.t1 === t0) last.t1 = t1; else blocks.push({ state, t0, t1, aw });
    }
    return { points: pts, home, blocks, activities, away };
  }

  // summary of a time window [t0, t1)
  function summarize(all, t0, t1) {
    const clip = b => Math.max(0, Math.min(b.t1, t1) - Math.max(b.t0, t0)) / 1000;
    const time = {};
    for (const b of all.blocks) {
      const c = clip(b);
      time[b.state] = (time[b.state] || 0) + c;
      if (b.aw || b.state === 'away' || b.state === 'vehicle') time.out = (time.out || 0) + c;
    }
    const acts = all.activities.filter(a => a.start >= t0 && a.start < t1);
    const pts = all.points.filter(p => p.t >= t0 && p.t < t1);
    return {
      t0, t1, time, activities: acts, points: pts,
      distance: acts.reduce((s, a) => s + a.distance, 0),
      movingTime: acts.reduce((s, a) => s + a.movingTime, 0),
      maxV: acts.reduce((s, a) => Math.max(s, a.maxV), 0),
      rawDistance: pts.reduce((s, p, i) => i ? s + hav(pts[i - 1], p) : 0, 0),
    };
  }

  // net cost of locomotion for dogs (Taylor, Heglund & Maloiy 1982): 10.7·M^-0.316 J/(kg·m)
  const kcal = (meters, kg) => kg > 0 ? 10.7 * Math.pow(kg, 0.684) * meters / 4184 : null;

  return { CFG, ZONES, parseGPX, clean, analyzeTrack, analyzeAll, summarize, findHome, hav, kcal };
})();
/* ENGINE END */
if (typeof module !== 'undefined') module.exports = Engine;
