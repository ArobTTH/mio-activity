/* Mio 运动: iPhone-first PWA. Every byte of data stays on the device (IndexedDB). */
(() => {
'use strict';
const E = Engine;
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = n => String(n).padStart(2, '0');
const root = $('#app');
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;

// ---------- settings ----------
const KEY_S = 'mio.settings.v1';
const DEFAULTS = { name: 'Mio', weight: '', goalKm: 2, goalMin: 60, goalWalks: 2, tz: '', mapProvider: 'esri', gkey: '', base: 'map', hideA2HS: false, ghRepo: 'ArobTTH/mio-data', ghToken: '', lastSync: 0, placeLookup: true, speedUnit: 'kmh' };
const KEY_SHA = 'mio.sync.shas.v1';
const ls = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};
let S = { ...DEFAULTS, ...(ls.get(KEY_S) || {}) };
const saveSettings = () => ls.set(KEY_S, S);

// ---------- storage (IndexedDB, falls back to memory) ----------
const DB = (() => {
  let db = null; const mem = new Map();
  // Safari can leave the first indexedDB.open() hanging after a cold start; poking indexedDB.databases() wakes it up.
  const wake = () => new Promise(res => {
    if (!window.indexedDB || !indexedDB.databases) return res();
    let done = false; const finish = () => { if (!done) { done = true; clearInterval(iv); res(); } };
    const poke = () => indexedDB.databases().then(finish, finish);
    const iv = setInterval(poke, 100); poke(); setTimeout(finish, 1500);
  });
  const tryOpen = ms => new Promise(res => {
    let settled = false; const fin = v => { if (!settled) { settled = true; res(v); } };
    setTimeout(() => fin('timeout'), ms);
    try {
      const r = indexedDB.open('mio-activity', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('files', { keyPath: 'id' });
      r.onsuccess = () => { if (settled) { r.result.close(); return; } db = r.result; fin('ok'); };
      r.onerror = () => fin('error');
      r.onblocked = () => fin('blocked');
    } catch { fin('error'); }
  });
  const open = async () => {
    if (!window.indexedDB) return 'none';
    await wake();
    let s = await tryOpen(4000);
    if (s === 'timeout') s = await tryOpen(6000);
    return s;
  };
  const run = (mode, fn) => new Promise((res, rej) => {
    const t = db.transaction('files', mode); const q = fn(t.objectStore('files'));
    t.oncomplete = () => res(q ? q.result : undefined); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
  });
  return {
    open,
    ok: () => !!db,
    all: () => db ? run('readonly', st => st.getAll()) : Promise.resolve([...mem.values()]),
    put: rec => db ? run('readwrite', st => st.put(rec)) : (mem.set(rec.id, rec), Promise.resolve()),
    del: id => db ? run('readwrite', st => st.delete(id)) : (mem.delete(id), Promise.resolve()),
    clear: () => db ? run('readwrite', st => st.clear()) : (mem.clear(), Promise.resolve()),
  };
})();
const pack = pts => pts.map(p => [p.t, +p.lat.toFixed(6), +p.lon.toFixed(6), p.ele == null ? null : Math.round(p.ele * 10) / 10, p.spd]);
const unpack = a => a.map(r => ({ t: r[0], lat: r[1], lon: r[2], ele: r[3], spd: r[4] }));

// ---------- time (tz offsets cached per hour; all "local" math uses UTC getters on shifted dates) ----------
const sysTz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } })();
const tz = () => S.tz || sysTz;
let offCache = new Map(), partsFmt = null;
function rawOffset(t) {
  if (!partsFmt) partsFmt = new Intl.DateTimeFormat('en-US', { timeZone: tz(), year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const o = {}; for (const p of partsFmt.formatToParts(t)) o[p.type] = p.value;
  return Date.UTC(+o.year, o.month - 1, +o.day, +o.hour % 24, +o.minute, +o.second) - Math.floor(t / 1000) * 1000;
}
function off(t) { const h = Math.floor(t / 3600e3); let o = offCache.get(h); if (o === undefined) { o = rawOffset(h * 3600e3); offCache.set(h, o); } return o; }
function resetTz() { offCache = new Map(); partsFmt = null; }
const LD = t => new Date(t + off(t));
const dayKey = t => LD(t).toISOString().slice(0, 10);
const hourOf = t => LD(t).getUTCHours();
function dayStart(key) { const [y, m, d] = key.split('-').map(Number); const g = Date.UTC(y, m - 1, d); let t = g - off(g); t = g - off(t); return t; }
const addDays = (key, n) => { const [y, m, d] = key.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
const keyDate = key => { const [y, m, d] = key.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
const todayKey = () => dayKey(Date.now());
const WD = '日一二三四五六';
const mdKey = key => { const d = keyDate(key); return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日`; };
const wdKey = key => '周' + WD[keyDate(key).getUTCDay()];
const hm = t => { const d = LD(t); return pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()); };
const hms = t => { const d = LD(t); return hm(t) + ':' + pad(d.getUTCSeconds()); };
const mondayOf = key => addDays(key, -((keyDate(key).getUTCDay() + 6) % 7));

// ---------- number formatting ----------
function durParts(s) {
  s = Math.max(0, Math.round(s));
  if (s < 60) return [[s, '秒']];
  const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60;
  if (h) return m ? [[h, '小时'], [m, '分']] : [[h, '小时']];
  return x ? [[m, '分'], [x, '秒']] : [[m, '分']];
}
const durHTML = s => durParts(s).map(([v, u]) => `${v}<span class="u">${u}</span>`).join('');
const durText = s => durParts(s).map(([v, u]) => v + u).join('');
const clock = s => { s = Math.round(s); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60; return h ? `${h}:${pad(m)}:${pad(x)}` : `${m}:${pad(x)}`; };
const distParts = m => m < 1000 ? [String(Math.round(m)), 'm'] : [(m / 1000).toFixed(m < 10000 ? 2 : 1), 'km'];
const distHTML = m => { const [v, u] = distParts(m); return `${v}<span class="u">${u}</span>`; };
const distText = m => distParts(m).join(' ');
// speeds are m/s inside and shown in km/h or mph (设置 → 速度单位); distances stay metric
const SPK = () => S.speedUnit === 'mph' ? 2.236936 : 3.6;
const spU = () => S.speedUnit === 'mph' ? 'mph' : 'km/h';
const spd = v => (v * SPK()).toFixed(1);
const spdHTML = v => `${spd(v)}<span class="u">${spU()}</span>`;
const spdText = v => `${spd(v)} ${spU()}`;
const pace = v => { if (!(v > 0.05)) return '—'; const s = Math.round(1000 / v); return `${Math.floor(s / 60)}'${pad(s % 60)}"`; };
const ZC = ['var(--z0)', 'var(--z1)', 'var(--z2)', 'var(--z3)', 'var(--z4)'];
const zoneColor = z => z === -2 ? 'var(--veh)' : ZC[Math.max(0, z)] || ZC[0];
const zoneName = z => z === -2 ? '乘车' : z === -1 ? '无记录' : E.ZONES[Math.max(0, z)].name;
const niceMax = v => { const e = Math.pow(10, Math.floor(Math.log10(v || 1))); for (const s of [1, 2, 2.5, 5, 10]) if (s * e >= v) return s * e; return 10 * e; };
const bisect = (arr, t) => { let lo = 0, hi = arr.length - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (arr[m].t < t) lo = m; else hi = m; } return Math.abs(arr[lo].t - t) <= Math.abs(arr[hi].t - t) ? lo : hi; };
const cssVar = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const isDark = () => { const th = document.documentElement.dataset.theme; return th === 'dark' || (th !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches); };

// ---------- data ----------
const D = { files: [], synced: [], health: new Map(), names: [], places: new Map(), demo: false, A: null, days: new Map(), acts: [], byId: new Map() };
const isWalk = a => a.distance >= 50 && a.vehicleTime < a.duration * 0.5;

function analyze(points) {
  D.A = E.analyzeAll(points);
  D.acts = D.A.activities.slice().sort((a, b) => b.start - a.start);
  D.byId = new Map(D.acts.map(a => [String(a.start), a]));
  computeDays();
}
function emptyDay(key) { return { key, dist: 0, sec: 0, walks: [], acts: [], hourly: new Array(24).fill(0), cover: new Array(24).fill(0), live: new Array(24).fill(0), maxV: 0 }; }
function computeDays() {
  const days = new Map();
  const get = k => { let d = days.get(k); if (!d) days.set(k, d = emptyDay(k)); return d; };
  for (const p of D.A.points) { const L = LD(p.t); get(L.toISOString().slice(0, 10)).cover[L.getUTCHours()]++; }
  for (const a of D.A.activities) {
    const d0 = get(dayKey(a.start));
    d0.acts.push(a); if (isWalk(a)) d0.walks.push(a);
    d0.maxV = Math.max(d0.maxV, a.maxV);
    const s = a.samples;
    for (let i = 1; i < s.length; i++) {
      const q = s[i], p = s[i - 1];
      if (q.zone === -1) continue;
      const L = LD(p.t), d = get(L.toISOString().slice(0, 10)), h = L.getUTCHours(), dt = (q.t - p.t) / 1000;
      d.dist += q.d - p.d;
      if (!q.vehicle && q.zone > 0) { d.sec += dt; d.hourly[h] += dt; }
      if (a.live && q.dense) d.live[h] += dt;
    }
  }
  D.days = days;
}
const hasData = key => { const d = D.days.get(key); return (!!d && d.cover.some(x => x > 0)) || D.health.has(key); };
function tractiveOf(key) {
  const r = D.health.get(key), a = r && r.data && r.data.activity;
  if (!a || a.minutesActive == null) return null;
  const s = r.data.sleep || {};
  const hourly = Array.isArray(a.hourlyDistribution) && a.hourlyDistribution.length === 24 ? a.hourlyDistribution.map(x => +x || 0) : null;
  return { active: +a.minutesActive || 0, goal: +a.minutesGoal || null, hourly, night: s.minutesNightSleep, nap: s.minutesDaySleep, calm: s.minutesCalm, synced: Date.parse(r.data.activityDataSyncedAt) || r.fetched };
}
const actMin = d => { const t = tractiveOf(d.key); return t ? t.active : d.sec / 60; };
const dayOf = key => D.days.get(key) || emptyDay(key);
const fracs = d => [d.dist / 1000 / (+S.goalKm || 2), actMin(d) / (+S.goalMin || 60), d.walks.length / (+S.goalWalks || 2)];

async function loadData() {
  const all = await DB.all();
  const recs = all.filter(r => Array.isArray(r.pts) && r.pts.length);
  D.health = new Map(all.filter(r => r.kind === 'health').map(r => [r.day, r]));
  D.names = all.filter(r => r.kind === 'name' && r.name);
  D.places = new Map(all.filter(r => r.kind === 'place').map(r => [r.cell, r]));
  D.files = recs.filter(r => r.kind !== 'sync').map(({ pts, ...m }) => m).sort((a, b) => a.first - b.first);
  D.synced = recs.filter(r => r.kind === 'sync').map(({ pts, ...m }) => m).sort((a, b) => a.first - b.first);
  if (!S.goalMinCustom) {
    const latest = [...D.health.values()].sort((a, b) => (b.fetched || 0) - (a.fetched || 0))[0];
    const g = latest && latest.data && latest.data.activity && +latest.data.activity.minutesGoal;
    if (g > 0 && g !== S.goalMin) { S.goalMin = g; saveSettings(); }
  }
  if (recs.length) { D.demo = false; analyze(recs.flatMap(r => unpack(r.pts))); }
  else { D.demo = true; analyze(demoPoints()); }
  setTimeout(resolvePlaces, 0);
}

// ---------- automatic sync from the private GitHub repo that GitHub Actions fills every hour ----------
const syncReady = () => !!(S.ghRepo && S.ghToken);
async function ghApi(path, opts = {}) {
  const r = await fetch('https://api.github.com' + path, { ...opts, cache: 'no-store', headers: { Authorization: 'Bearer ' + S.ghToken, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(opts.headers || {}) } });
  const fail = (status, msg) => { const e = new Error(msg); e.status = status; throw e; };
  if (r.status === 401) fail(401, 'GitHub 令牌无效或已过期，请在设置里换一个');
  if (r.status === 403) fail(403, '令牌权限不够');
  if (r.status === 404) fail(404, '找不到数据仓库，检查仓库名，以及令牌是否选了 mio-data 这个仓库');
  if (r.status === 409) return null; // empty repository
  if (!r.ok && r.status !== 204) throw new Error('GitHub 返回错误 ' + r.status);
  return r.status === 204 ? null : r.json();
}
const b64text = b64 => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s/g, '')), c => c.charCodeAt(0)));
let syncing = false;
async function pullSync({ quiet = true } = {}) {
  if (!syncReady() || syncing) return null;
  syncing = true;
  try {
    const tree = await ghApi(`/repos/${S.ghRepo}/git/trees/HEAD?recursive=1`);
    const shas = ls.get(KEY_SHA) || {};
    const todo = ((tree && tree.tree) || []).filter(e => e.type === 'blob' && /^(days|health)\/\d{4}-\d{2}-\d{2}\.json$/.test(e.path) && shas[e.path] !== e.sha);
    let days = 0;
    for (let i = 0; i < todo.length; i += 4) {
      await Promise.all(todo.slice(i, i + 4).map(async e => {
        const blob = await ghApi(`/repos/${S.ghRepo}/git/blobs/${e.sha}`);
        const j = JSON.parse(b64text(blob.content));
        if (e.path.startsWith('days/')) {
          const pts = (j.points || []).filter(p => Array.isArray(p) && p.length >= 3).map(p => [p[0], p[1], p[2], p[3] ?? null, p[4] ?? null]);
          if (pts.length) { await DB.put({ id: 'sync:' + j.day, kind: 'sync', name: 'Tractive ' + j.day, added: Date.now(), count: pts.length, creator: 'Tractive 自动同步', first: pts[0][0], last: pts[pts.length - 1][0], pts }); days++; }
        } else {
          await DB.put({ id: 'health:' + j.day, kind: 'health', day: j.day, fetched: j.fetched, data: j.data });
        }
        shas[e.path] = e.sha;
      }));
    }
    ls.set(KEY_SHA, shas);
    S.lastSync = Date.now(); saveSettings();
    if (todo.length) { await loadData(); render(); }
    if (!quiet) toast(days ? `已同步 ${days} 天的新轨迹` : todo.length ? '已更新活动概览' : '已经是最新的了');
    return days;
  } catch (e) {
    const msg = e.status === 403 ? '令牌不能读取 mio-data，请给令牌加上 Contents: Read-only 权限' : e.message;
    if (!quiet || navigator.onLine) toast('同步失败：' + msg, 8000);
    return null;
  } finally { syncing = false; }
}
// Ask GitHub Actions to fetch from Tractive right now, wait for it, then pull.
// Only one at a time: extra taps while a run is going would start extra runs that fight over the same files.
let fetching = false;
async function syncNow() {
  if (!syncReady()) { location.hash = '#/settings'; toast('先在设置里填好数据仓库和令牌'); return; }
  if (fetching) { toast('正在从 Tractive 拉取，大约需要 1 分钟…', 120000); return; }
  fetching = true;
  try { return await syncRun(); } finally { fetching = false; }
}
async function syncRun() {
  const since = Date.now() - 5000;
  toast('正在请求同步…', 120000);
  try {
    await ghApi(`/repos/${S.ghRepo}/actions/workflows/sync.yml/dispatches`, { method: 'POST', body: JSON.stringify({ ref: 'main', inputs: { days: '2' } }) });
  } catch (e) {
    if (e.status !== 403) { toast('没法触发同步（' + e.message + '），先读取已有数据'); return pullSync({ quiet: false }); }
    const n = await pullSync({ quiet: true });
    if (n !== null) toast('已读取最新数据。想用「同步」按钮马上从 Tractive 拉取，需要把令牌的 Actions 权限改成 Read and write', 8000);
    return n;
  }
  toast('正在从 Tractive 拉取，大约需要 1 分钟…', 120000);
  for (let i = 0; i < 24; i++) {
    await new Promise(r => setTimeout(r, 6000));
    try {
      const runs = await ghApi(`/repos/${S.ghRepo}/actions/workflows/sync.yml/runs?event=workflow_dispatch&per_page=3`);
      const run = ((runs && runs.workflow_runs) || []).find(r => Date.parse(r.created_at) >= since);
      if (run && run.status === 'completed') {
        if (run.conclusion !== 'success') { toast('Tractive 同步没成功，请到 GitHub 的 Actions 页面看日志'); return; }
        return pullSync({ quiet: false });
      }
    } catch { /* keep waiting */ }
  }
  toast('同步还在进行，稍后再打开 App 就能看到');
}

// ---------- names: the user's own names first, otherwise place + what Mio did there ----------
const KINDS = ['撒欢', '跑步', '玩耍', '散步'];
const PARKISH = { leisure: ['dog_park', 'park', 'garden', 'nature_reserve', 'recreation_ground', 'common'], boundary: ['national_park', 'protected_area'], landuse: ['recreation_ground'] };
const HOME_NEAR = 400; // m: activities centred this close to home are never looked up
// a custom name sticks to the activity whose time overlaps it most (activities can grow as new points sync)
const overlap = (a, r) => Math.max(0, Math.min(a.end, r.t1) - Math.max(a.start, r.t0));
function customRec(a) {
  let best = null, bo = 0;
  for (const r of D.names) { const o = overlap(a, r); if (o > bo) { bo = o; best = r; } }
  return best && bo >= 0.5 * Math.max(1, Math.min(a.end - a.start, best.t1 - best.t0)) ? best : null;
}
// shape of the track: centre point, how tightly it stays in one area, and fast bursts
function feats(a) {
  if (a._f) return a._f;
  const s = a.samples, n = s.length, kx = Math.cos(s[0].lat * Math.PI / 180) * 111320, ky = 110574;
  const w = s.map((p, i) => i < n - 1 ? Math.min(30, (s[i + 1].t - p.t) / 1000) : 0);
  let W = 0, X = 0, Y = 0;
  s.forEach((p, i) => { W += w[i]; X += w[i] * p.lon; Y += w[i] * p.lat; });
  W = W || 1; X /= W; Y /= W;
  let r2 = 0, mid = 0, md = Infinity;
  s.forEach((p, i) => { const d2 = ((p.lon - X) * kx) ** 2 + ((p.lat - Y) * ky) ** 2; r2 += w[i] * d2; if (d2 < md) { md = d2; mid = i; } });
  const rg = Math.sqrt(r2 / W);
  const bursts = (a.sprints || []).length; // ≥ 4 s faster than 10.8 km/h, see engine
  return (a._f = { mid: s[mid], rg, ratio: a.distance / Math.max(rg, 1), run: (a.zoneTime[3] + a.zoneTime[4]) / (a.movingTime || 1), bursts, perH: bursts / Math.max(a.duration / 3600, 0.05) });
}
const nearHome = a => !!(D.A && D.A.home) && E.hav(feats(a).mid, D.A.home) < HOME_NEAR;
const cellOf = p => p.lat.toFixed(3) + ',' + p.lon.toFixed(3);
function inPoly(geo, lon, lat) {
  let c = false;
  for (const poly of geo.type === 'Polygon' ? [geo.coordinates] : geo.coordinates) for (const ring of poly) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) c = !c;
    }
  }
  return c;
}
const inPlace = (rec, q) => rec.geo ? inPoly(rec.geo, q.lon, q.lat) : rec.bbox && rec.bbox.length === 4 && q.lat >= rec.bbox[0] && q.lat <= rec.bbox[1] && q.lon >= rec.bbox[2] && q.lon <= rec.bbox[3];
function placeOf(a) {
  if (a._p !== undefined) return a._p;
  const rec = D.places.get(cellOf(feats(a).mid));
  if (!rec) return null; // not looked up yet
  let p = null;
  if (rec.ok && rec.name && a.samples.filter(q => inPlace(rec, q)).length >= a.samples.length * 0.5) {
    const dog = rec.type === 'dog_park';
    const bare = dog ? rec.name.replace(/\s*(dog\s*park|狗公园)\s*$/i, '').trim() : '';
    p = { name: rec.name, dog, short: dog ? '狗公园' : rec.name.length <= 16 ? rec.name : '公园', label: bare && bare !== rec.name ? bare + ' 狗公园' : rec.name };
  }
  return (a._p = p);
}
function kindOf(a) {
  if (!a.live) return null;
  const f = feats(a), p = placeOf(a);
  const lively = (f.bursts >= 3 && f.perH >= 6) || f.run >= 0.15;
  if ((p && p.dog) || (a.distance >= 300 && f.ratio >= 25)) return lively ? '撒欢' : '玩耍';
  if (f.run >= 0.35) return '跑步';
  return '散步';
}
const joinName = (where, kind) => where ? where + (/[A-Za-z0-9]$/.test(where) ? ' ' : '') + kind : kind;
const whereOf = a => { const p = placeOf(a); return p ? (p.dog ? p.label : p.short) : nearHome(a) ? '家附近' : ''; };
function autoName(a) {
  const k = kindOf(a), where = whereOf(a);
  if (!k) return where && where !== '家附近' ? '去' + where : '外出';
  return joinName(where, k);
}
const actName = a => { const r = customRec(a); return r ? r.name : autoName(a); };
function refreshNames() {
  root.querySelectorAll('[data-aname]').forEach(el => { const a = D.byId.get(el.dataset.aname); if (a) el.textContent = actName(a); });
  root.querySelectorAll('[data-aplace]').forEach(el => { const a = D.byId.get(el.dataset.aplace); if (a) el.innerHTML = placeLine(a); });
}
const placeLine = a => { const p = placeOf(a); return p ? `${IC.pin}<span>${esc(p.name)}</span><small>© OpenStreetMap</small>` : nearHome(a) ? `${IC.pin}<span>家附近</span>` : ''; };

// Park names come from OpenStreetMap (Nominatim, ≤ 1 request a second). Only the centre of an activity away
// from home is sent; answers are kept on the phone, so each place is asked once.
const placeTried = new Set();
let placeBusy = false;
async function resolvePlaces() {
  if (placeBusy || D.demo || !S.placeLookup || !navigator.onLine) return;
  placeBusy = true;
  try {
    const todo = [];
    for (const a of D.acts) {
      if (todo.length >= 30) break;
      const f = feats(a), cell = cellOf(f.mid), rec = D.places.get(cell);
      if ((rec && (rec.ok || Date.now() - rec.at < 30 * 86400e3)) || placeTried.has(cell) || nearHome(a)) continue;
      placeTried.add(cell); todo.push([cell, f.mid]);
    }
    for (let i = 0; i < todo.length; i++) {
      if (i) await new Promise(r => setTimeout(r, 1100));
      const rec = await lookupPlace(...todo[i]);
      if (rec === 'stop') break;
      if (!rec) continue;
      D.places.set(rec.cell, rec);
      try { await DB.put(rec); } catch { /* cache only */ }
      D.acts.forEach(a => { a._p = undefined; });
      refreshNames();
    }
  } finally { placeBusy = false; }
}
async function lookupPlace(cell, p) {
  const u = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${p.lat.toFixed(5)}&lon=${p.lon.toFixed(5)}&zoom=18&layer=poi&polygon_geojson=1&polygon_threshold=0.00005&accept-language=zh-CN,zh,en`;
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 15000);
  let j;
  try {
    const r = await fetch(u, { signal: ctl.signal });
    if (r.status === 429 || r.status === 403) return 'stop';
    if (!r.ok) return null;
    j = await r.json();
  } catch { return null; } finally { clearTimeout(timer); }
  const rec = { id: 'place:' + cell, kind: 'place', cell, at: Date.now(), ok: false };
  if (j && j.name && PARKISH[j.category] && PARKISH[j.category].includes(j.type)) {
    Object.assign(rec, { ok: true, name: j.name, cat: j.category, type: j.type, bbox: (j.boundingbox || []).map(Number) });
    const g = j.geojson;
    if (g && (g.type === 'Polygon' || g.type === 'MultiPolygon') && JSON.stringify(g.coordinates).length < 300000) rec.geo = g;
  }
  return rec;
}

// rename sheet: free text plus one-tap suggestions
function renameBox(a) {
  const cur = customRec(a), auto = autoName(a), p = placeOf(a), where = whereOf(a), k = kindOf(a);
  const sugg = [auto, ...(k ? KINDS.map(x => joinName(where, x)) : [])];
  if (p && p.label !== p.short) sugg.push(joinName(p.short, k || '散步'));
  D.names.slice().sort((x, y) => (y.at || 0) - (x.at || 0)).forEach(r => sugg.push(r.name));
  const chips = [...new Set(sugg.filter(Boolean))].slice(0, 9);
  const d = document.createElement('dialog');
  d.className = 'namebox';
  d.innerHTML = `<form><h3 tabindex="-1" autofocus>给这次运动起个名字</h3>
    <input id="nmIn" maxlength="30" autocomplete="off" enterkeyhint="done" value="${esc(cur ? cur.name : auto)}" aria-label="运动名称">
    <div class="chips">${chips.map(c => `<button type="button" class="chip" data-chip="${esc(c)}">${esc(c)}</button>`).join('')}</div>
    <p class="hint">${p ? `识别到的地点：${esc(p.name)}（© OpenStreetMap）。` : ''}自动名称按地点和 ${esc(S.name)} 的动作来起：一直快跑、冲刺多叫撒欢，在小范围里慢慢转叫玩耍。</p>
    <div class="bar">${cur ? '<button type="button" class="btn secondary" data-v="auto">用自动名称</button>' : ''}<span style="flex:1"></span><button type="button" class="btn secondary" data-v="cancel">取消</button><button type="submit" class="btn">保存</button></div></form>`;
  document.body.appendChild(d);
  const inp = $('#nmIn', d);
  const close = () => { d.close(); d.remove(); };
  const save = async name => {
    for (const r of D.names.filter(r => overlap(a, r) > 0)) { await DB.del(r.id); }
    D.names = D.names.filter(r => overlap(a, r) <= 0);
    if (name && name !== auto) {
      const rec = { id: 'name:' + a.start, kind: 'name', t0: a.start, t1: a.end, name, at: Date.now() };
      await DB.put(rec); D.names.push(rec);
    }
    refreshNames();
  };
  d.addEventListener('click', e => {
    const c = e.target.closest('[data-chip]'); if (c) { inp.value = c.dataset.chip; return; }
    const b = e.target.closest('[data-v]'); if (!b) return;
    close(); if (b.dataset.v === 'auto') save('').then(() => toast('已换回自动名称'));
  });
  $('form', d).addEventListener('submit', e => { e.preventDefault(); const v = inp.value.trim().slice(0, 30); close(); save(v); });
  d.addEventListener('cancel', () => d.remove());
  d.showModal();
}

// ---------- icons ----------
const IC = {
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  left: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>',
  right: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></svg>',
  chev: '<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></svg>',
  up: '<svg viewBox="0 0 12 12"><path d="M6 1.5 11 9H1z" fill="currentColor"/></svg>',
  down: '<svg viewBox="0 0 12 12"><path d="M6 10.5 1 3h10z" fill="currentColor"/></svg>',
  flat: '<svg viewBox="0 0 12 12"><rect x="1" y="5" width="10" height="2" rx="1" fill="currentColor"/></svg>',
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/></svg>',
  trophy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M7 6H4.5v1.5A3.5 3.5 0 0 0 8 11M17 6h2.5v1.5A3.5 3.5 0 0 1 16 11M12 14v3.5M8.5 20.5h7M9.5 17.5h5"/></svg>',
  bolt: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M13.5 2 5 13.5h6L10 22l9-12h-6.2z"/></svg>',
  run: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 9h5M1.5 13h4.5M3.5 17h4"/><circle cx="16" cy="5" r="2"/><path d="M9 20l3.5-4 3 2 2.5-6-3.5-2.5-4 1.5-1.5 3M15.5 12.5l3 2.5h3"/></svg>',
  route: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="18" r="2.4"/><circle cx="18" cy="6" r="2.4"/><path d="M8.4 18H15a3 3 0 0 0 0-6H9a3 3 0 0 1 0-6h6.6"/></svg>',
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
  sun: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/></svg>',
  moon: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M14.5 3.2a8.8 8.8 0 1 0 6.3 13.4A7.3 7.3 0 0 1 14.5 3.2z"/></svg>',
  cal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15.5" rx="3"/><path d="M3.5 10h17M8 3v4M16 3v4"/><path d="M8.5 15l2.2 2 4.8-4.5" stroke-linejoin="round"/></svg>',
  flag: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 21V4"/><path d="M6 4h11l-2.5 4L17 12H6" fill="currentColor"/></svg>',
  paw: '<svg viewBox="0 0 26 26" fill="currentColor" aria-hidden="true"><ellipse cx="7" cy="10.5" rx="2.3" ry="3"/><ellipse cx="11.2" cy="6.6" rx="2.3" ry="3.1"/><ellipse cx="16.2" cy="6.8" rx="2.3" ry="3.1"/><ellipse cx="20" cy="11" rx="2.2" ry="2.9"/><path d="M13.6 12.2c-3.2 0-6.4 4.1-6.4 6.8 0 2.1 1.7 3.2 3.5 3.2 1.3 0 2-.6 3-.6s1.7.6 3 .6c1.8 0 3.5-1.1 3.5-3.2 0-2.7-3.2-6.8-6.6-6.8z"/></svg>',
  flame: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12.5 2.5c.6 3.2-1.4 4.9-3 6.6-1.5 1.6-2.8 3.3-2.8 5.9A5.4 5.4 0 0 0 12 20.5a5.6 5.6 0 0 0 5.6-5.6c0-2.3-1-3.8-2-5.1-.3 1.4-1 2.3-2 2.6.8-2.9.4-6.4-1.1-9.9z"/></svg>',
  pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/></svg>',
};

// ---------- rings ----------
function ringsSVG(fs, size, stroke, gap, cls = '', colors = ['var(--r-dist)', 'var(--r-min)', 'var(--r-walk)']) {
  const c = size / 2; let r = c - stroke / 2, out = '';
  fs.forEach((f, i) => {
    const C = 2 * Math.PI * r, ff = Math.max(0, Math.min(1, f || 0));
    out += `<circle cx="${c}" cy="${c}" r="${r}" fill="none" style="stroke:${colors[i]}" stroke-opacity=".18" stroke-width="${stroke}"/>`;
    if (ff > 0.004) out += `<circle cx="${c}" cy="${c}" r="${r}" fill="none" style="stroke:${colors[i]}" stroke-width="${stroke}" stroke-linecap="round" stroke-dasharray="${(C * ff).toFixed(2)} ${C.toFixed(2)}" transform="rotate(-90 ${c} ${c})"/>`;
    r -= stroke + gap;
  });
  return `<svg class="${cls}" viewBox="0 0 ${size} ${size}" aria-hidden="true">${out}</svg>`;
}

// ---------- router ----------
function route() { const p = location.hash.replace(/^#\/?/, '').split('/'); return { view: p[0] || 'today', arg: p[1] ? decodeURIComponent(p[1]) : null }; }
let cleanup = [];
function render() {
  cleanup.forEach(f => { try { f(); } catch { /* ignore */ } }); cleanup = [];
  hideTip();
  const r = route();
  const tab = r.view === 'walk' ? 'walks' : r.view;
  document.querySelectorAll('.tabs a').forEach(a => { if (a.dataset.tab === tab) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  if (r.view === 'history') return viewHistory(r.arg);
  if (r.view === 'walks') return viewWalks();
  if (r.view === 'walk') return viewWalk(r.arg);
  if (r.view === 'records') return viewRecords();
  if (r.view === 'settings') return viewSettings();
  return viewToday(r.arg);
}
let navCount = 0;
addEventListener('hashchange', () => { navCount++; render(); scrollTo(0, 0); });

function head(eyebrow, title, actions = '') {
  return `<header class="head"><div style="min-width:0"><div class="eyebrow">${esc(eyebrow)}</div><h1>${esc(title)}</h1></div><div class="acts">${actions}</div></header>`;
}
const importBtnHTML = `<button class="icon-btn" type="button" data-do="import" aria-label="导入 GPX">${IC.plus}</button>`;
const syncBtnHTML = `<button class="icon-btn" type="button" data-do="sync" aria-label="立即同步"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 0 0-14.6-4.5M4 4v3h3M4 13a8 8 0 0 0 14.6 4.5M20 20v-3h-3"/></svg></button>`;
const importBtnFn = () => syncReady() ? syncBtnHTML : importBtnHTML;
function banners() {
  let h = '';
  if (D.demo) h += syncReady()
    ? `<div class="banner"><span>这是示例数据。自动同步还没拿到 ${esc(S.name)} 的数据。</span><button class="btn" type="button" data-do="sync">同步</button></div>`
    : `<div class="banner"><span>这是示例数据。设置自动同步，或导入 ${esc(S.name)} 的 GPX 后会自动替换。</span><button class="btn" type="button" data-go="#/settings">设置</button></div>`;
  if (isIOS && !standalone && !S.hideA2HS) h += `<div class="banner"><span>点 Safari 底部的分享按钮，选「添加到主屏幕」，就能像 App 一样全屏打开。</span><button class="btn secondary" type="button" data-do="hideA2HS">知道了</button></div>`;
  return h;
}

// ---------- view: today ----------
function viewToday(arg) {
  const tk = todayKey();
  const key = arg && /^\d{4}-\d{2}-\d{2}$/.test(arg) ? arg : tk;
  const d = dayOf(key), f = fracs(d), tr = tractiveOf(key);
  const title = key === tk ? '今天' : key === addDays(tk, -1) ? '昨天' : mdKey(key);
  const eyebrow = key === tk || key === addDays(tk, -1) ? `${mdKey(key)} ${wdKey(key)}` : wdKey(key);
  const nav = `<button class="icon-btn" type="button" data-go="#/today/${addDays(key, -1)}" aria-label="前一天">${IC.left}</button><button class="icon-btn" type="button" data-go="#/today/${addDays(key, 1)}" aria-label="后一天" ${key >= tk ? 'disabled' : ''}>${IC.right}</button>${importBtnFn()}`;
  // week strip
  const mon = mondayOf(key);
  let week = '<nav class="week" aria-label="本周">';
  for (let i = 0; i < 7; i++) {
    const k = addDays(mon, i), dd = dayOf(k), future = k > tk;
    week += `<button type="button" data-go="#/today/${k}" ${k === key ? 'aria-current="date"' : ''} class="${k === tk ? 'today' : ''}" ${future ? 'disabled' : ''} aria-label="${mdKey(k)}"><b>${WD[(i + 1) % 7]}</b>${hasData(k) ? ringsSVG(fracs(dd), 34, 4, 1) : `<span class="nod" style="width:34px;height:34px"></span>`}</button>`;
  }
  week += '</nav>';
  const g = { km: +S.goalKm || 2, min: +S.goalMin || 60, w: +S.goalWalks || 2 };
  const metric = (i, label, val, goal) => `<div class="metric"><div class="k"><i style="background:${['var(--r-dist)', 'var(--r-min)', 'var(--r-walk)'][i]}"></i>${label} ${Math.round(f[i] * 100)}%</div><div class="v">${val}<small>/ ${goal}</small></div></div>`;
  const ringsCard = `<section class="card" aria-label="今日目标"><div class="summary">${ringsSVG(f, 172, 20, 3, 'rings')}<div class="metrics">
      ${metric(0, '距离', (d.dist / 1000).toFixed(2), g.km + ' km')}
      ${metric(1, '活动', Math.round(actMin(d)), g.min + ' 分钟')}
      ${metric(2, '散步', d.walks.length, g.w + ' 次')}
    </div></div>${tr ? `<p class="hint" style="margin:12px 0 0">活动分钟来自 Tractive 项圈传感器，更新于 ${hm(tr.synced)}</p>` : hasData(key) ? '' : `<p class="hint" style="margin:12px 0 0">这一天还没有数据。</p>`}</section>`;
  // stats
  const [t0, t1] = [dayStart(key), dayStart(addDays(key, 1))];
  const sum = hasData(key) ? E.summarize(D.A, t0, t1) : null;
  const kc = E.kcal(d.dist, +S.weight);
  const coverH = d.cover.filter(x => x > 0).length;
  const stats = `<section class="card"><div class="stats">
      <div><div class="l">活动消耗</div><div class="v">${kc != null ? `≈${Math.round(kc)}<span class="u">千卡</span>` : '—'}</div><div class="s">${kc != null ? `按 ${S.weight} kg 估算` : `<button type="button" data-go="#/settings">填写体重</button>后显示`}</div></div>
      <div><div class="l">最高速度</div><div class="v">${spdHTML(d.maxV)}</div><div class="s">运动记录里的最快时刻</div></div>
      <div><div class="l">外出</div><div class="v">${durHTML(sum ? sum.time.out || 0 : 0)}</div><div class="s">离开常待地点 100 m 以外</div></div>
      <div><div class="l">有定位的时段</div><div class="v">${coverH}<span class="u">/ 24 小时</span></div><div class="s">${coverH < 20 && hasData(key) ? '追踪器省电或没信号时不记录' : '&nbsp;'}</div></div>
    </div></section>`;
  const walks = d.acts.slice().sort((a, b) => a.start - b.start);
  root.innerHTML = banners() + head(eyebrow, title, nav) + week + ringsCard +
    `<section class="card"><h2>活动时间分布</h2><p class="hint">${tr && tr.hourly ? '每小时的活动分钟，来自 Tractive 项圈传感器' : '每小时检测到移动的分钟数，来自 GPS'}；下方色条是定位记录的情况</p><div class="chart" id="hourly"></div><div class="readout" id="hourlyRO">&nbsp;</div>
      <div class="legend"><span><i style="background:var(--r-min)"></i>活动</span><span><i style="background:var(--line-2)"></i>有定位</span><span><i style="background:var(--z2)"></i>LIVE 追踪</span><span><i class="hatch"></i>没有定位</span></div></section>` +
    (tr && (tr.night != null || tr.nap != null) ? `<section class="card"><h2>睡眠与休息</h2><p class="hint">来自 Tractive 项圈传感器</p><div class="stats">
      <div><div class="l">夜间睡眠</div><div class="v">${tr.night != null ? durHTML(tr.night * 60) : '—'}</div></div>
      <div><div class="l">白天小睡</div><div class="v">${tr.nap != null ? durHTML(tr.nap * 60) : '—'}</div></div>
      <div><div class="l">安静休息</div><div class="v">${tr.calm != null ? durHTML(tr.calm * 60) : '—'}</div></div>
      <div><div class="l">Tractive 建议活动</div><div class="v">${tr.goal ? tr.goal + '<span class="u">分钟/天</span>' : '—'}</div></div>
    </div></section>` : '') +
    `<h2 class="sec-title">运动记录<small>${walks.length ? `${walks.length} 次 · ${distText(walks.reduce((s, a) => s + a.distance, 0))}` : ''}</small></h2>` +
    (walks.length ? `<div class="list">${walks.map(walkRow).join('')}</div>` : `<div class="card empty">${hasData(key) ? `<b>这天没有识别到运动。</b>Tractive 平时约 10 分钟才定位一次，看不出走动细节。遛 ${esc(S.name)} 时在 Tractive 里打开 <b>LIVE</b>，这里就能算出距离、速度和分段。` : '这天没有数据。'}</div>`) +
    `<h2 class="sec-title">更多</h2>` + stats;
  drawHourly(d);
}
function walkRow(a) {
  return `<button class="walk" type="button" data-go="#/walk/${a.start}">${thumb(a)}<div style="min-width:0"><div class="n" data-aname="${a.start}">${esc(actName(a))}</div><div class="w">${esc(mdKey(dayKey(a.start)))} ${hm(a.start)}–${hm(a.end)}${a.live ? ' · LIVE' : ''}</div><div class="m">${distHTML(a.distance)}${durHTML(a.movingTime)}</div></div>${IC.chev}</button>`;
}
function thumb(a) {
  const s = a.samples, k = Math.cos(s[0].lat * Math.PI / 180);
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  const xy = s.map(p => { const x = p.lon * k, y = -p.lat; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); return [x, y]; });
  const sc = 40 / Math.max(x1 - x0, y1 - y0, 1e-7), ox = 26 - (x1 + x0) / 2 * sc, oy = 26 - (y1 + y0) / 2 * sc;
  const step = Math.max(1, Math.floor(xy.length / 150));
  const d = xy.filter((_, i) => i % step === 0 || i === xy.length - 1).map(([x, y], i) => `${i ? 'L' : 'M'}${(x * sc + ox).toFixed(1)} ${(y * sc + oy).toFixed(1)}`).join('');
  return `<svg class="thumb" viewBox="0 0 52 52" aria-hidden="true"><path d="${d}" fill="none" style="stroke:var(--r-walk)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/><circle cx="${(xy[0][0] * sc + ox).toFixed(1)}" cy="${(xy[0][1] * sc + oy).toFixed(1)}" r="3" style="fill:var(--accent)"/></svg>`;
}

function drawHourly(d) {
  const el = $('#hourly'); if (!el) return;
  const W = Math.max(280, el.clientWidth), H = 150, pl = 28, pr = 4, pt = 8, ch = 96, sy = pt + ch + 22;
  const tq = tractiveOf(d.key);
  const mins = tq && tq.hourly ? tq.hourly : d.hourly.map(s => s / 60);
  const vmax = Math.max(10, niceMax(Math.max(...mins)));
  const bw = (W - pl - pr) / 24, w = Math.min(10, bw - 3);
  const Y = v => pt + ch - v / vmax * ch;
  let g = `<svg viewBox="0 0 ${W} ${H}" height="${H}" role="img" aria-label="每小时运动分钟"><defs><pattern id="hh" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="1.6" height="5" style="fill:var(--gap)"/></pattern></defs><g class="axis">`;
  [0, vmax / 2, vmax].forEach((v, i) => { const y = Y(v); g += `<line x1="${pl}" x2="${W - pr}" y1="${y}" y2="${y}" class="${i ? 'gridl' : 'basel'}"/><text x="${pl - 5}" y="${y + 4}" text-anchor="end">${Math.round(v)}</text>`; });
  [0, 6, 12, 18].forEach(h => { g += `<text x="${pl + bw * h + 1}" y="${sy + 22}" text-anchor="start">${pad(h)}:00</text>`; });
  g += `</g>`;
  mins.forEach((m, h) => {
    if (m <= 0) return;
    const x = pl + bw * h + (bw - w) / 2, y = Y(m), hh = Y(0) - y, r = Math.min(3, hh, w / 2);
    g += `<path d="M${x} ${Y(0)}V${y + r}Q${x} ${y} ${x + r} ${y}H${x + w - r}Q${x + w} ${y} ${x + w} ${y + r}V${Y(0)}Z" style="fill:var(--r-min)"/>`;
  });
  for (let h = 0; h < 24; h++) {
    const x = pl + bw * h + 0.5, ww = bw - 1;
    const fill = d.live[h] > 0 ? 'var(--z2)' : d.cover[h] > 0 ? 'var(--line-2)' : 'url(#hh)';
    g += `<rect x="${x.toFixed(1)}" y="${sy}" width="${ww.toFixed(1)}" height="8" rx="2" style="fill:${fill}"/>`;
  }
  g += `<rect id="hHit" x="${pl}" y="0" width="${W - pl - pr}" height="${H}" fill="transparent"/></svg>`;
  el.innerHTML = g;
  const ro = $('#hourlyRO');
  const at = ev => { const r = el.firstChild.getBoundingClientRect(); const h = Math.max(0, Math.min(23, Math.floor(((ev.clientX - r.left) / r.width * W - pl) / bw))); return h; };
  const show = ev => {
    const h = at(ev), m = mins[h];
    ro.innerHTML = `<b>${pad(h)}:00–${pad((h + 1) % 24)}:00</b>　活动 ${m >= 1 ? Math.round(m) + ' 分钟' : m > 0 ? '不到 1 分钟' : '0'}${d.live[h] > 0 ? ' · 有 LIVE 记录' : d.cover[h] ? '' : ' · 没有定位'}`;
  };
  const hit = $('#hHit', el);
  hit.addEventListener('pointermove', show); hit.addEventListener('pointerdown', show);
  hit.addEventListener('pointerleave', () => { ro.innerHTML = '&nbsp;'; });
}

// ---------- view: history ----------
let histMetric = 'min';
function viewHistory(arg) {
  const tk = todayKey();
  const month = arg && /^\d{4}-\d{2}$/.test(arg) ? arg : tk.slice(0, 7);
  // trends: last 7 days vs the 28 days before
  const win = (from, n) => { let dist = 0, sec = 0, walks = 0, wd = 0, wsec = 0, nd = 0; for (let i = 0; i < n; i++) { const k = addDays(from, -i); if (!hasData(k)) continue; const d = dayOf(k); nd++; dist += d.dist; sec += actMin(d) * 60; walks += d.walks.length; for (const a of d.walks) { wd += a.distance; wsec += a.movingTime; } } return { nd, dist: nd ? dist / nd : 0, sec: nd ? sec / nd : 0, walks: nd ? walks / nd : 0, v: wsec ? wd / wsec : 0 }; };
  const cur = win(tk, 7), prev = win(addDays(tk, -7), 28);
  let trends;
  if (cur.nd >= 3 && prev.nd >= 7) {
    const row = (l, v, unit, a, b, fmt) => {
      const ch = b > 0 ? (a - b) / b : 0, dir = Math.abs(ch) < 0.05 ? 'flat' : ch > 0 ? 'up' : 'down';
      const txt = dir === 'flat' ? '和前 4 周差不多' : `比前 4 周${ch > 0 ? '多' : '少'} ${Math.round(Math.abs(ch) * 100)}%（前 4 周平均 ${fmt(b)}）`;
      return `<div class="trend"><div class="l">${l}</div><div class="v">${v}<small>${unit}</small></div><div class="d">${IC[dir]}${txt}</div></div>`;
    };
    trends = `<section class="card"><h2>趋势</h2><p class="hint">最近 7 天的日均，和之前 4 周相比</p>
      ${row('每天距离', (cur.dist / 1000).toFixed(2), 'km', cur.dist, prev.dist, v => (v / 1000).toFixed(2) + ' km')}
      ${row('每天活动', Math.round(cur.sec / 60), '分钟', cur.sec, prev.sec, v => Math.round(v / 60) + ' 分钟')}
      ${row('每天散步', cur.walks.toFixed(1), '次', cur.walks, prev.walks, v => v.toFixed(1) + ' 次')}
      ${row('散步速度', spd(cur.v), spU(), cur.v, prev.v, spdText)}</section>`;
  } else {
    const n = [...D.days.keys()].filter(hasData).length;
    trends = `<section class="card"><h2>趋势</h2><p class="hint" style="margin-bottom:0">已有 ${n} 天的数据。最近 7 天里至少有 3 天、之前 4 周里至少有 7 天有数据时，这里会显示变化趋势。</p></section>`;
  }
  // calendar
  const [y, m] = month.split('-').map(Number);
  const first = `${month}-01`, nDays = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const lead = (keyDate(first).getUTCDay() + 6) % 7;
  const prevM = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7), nextM = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 7);
  let cal = '<div class="cal">' + '一二三四五六日'.split('').map(c => `<div class="dow">${c}</div>`).join('') + '<div></div>'.repeat(lead);
  for (let i = 1; i <= nDays; i++) {
    const k = `${month}-${pad(i)}`, fut = k > tk;
    cal += `<button type="button" data-go="#/today/${k}" class="${k === tk ? 'today' : ''}" ${fut ? 'disabled' : ''} aria-label="${mdKey(k)}"><span>${i}</span>${hasData(k) ? ringsSVG(fracs(dayOf(k)), 32, 4, 1) : (fut ? '<span style="height:32px"></span>' : '<span class="nod"></span>')}</button>`;
  }
  cal += '</div>';
  const seg = `<div class="seg" role="group" aria-label="指标">${[['dist', '距离'], ['min', '活动'], ['walks', '散步']].map(([k, l]) => `<button type="button" data-metric="${k}" aria-pressed="${histMetric === k}">${l}</button>`).join('')}</div>`;
  root.innerHTML = banners() + head(`${S.name} 的记录`, '历史', importBtnFn()) + trends +
    `<section class="card"><div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:10px"><h2>最近 30 天</h2>${seg}</div><div class="chart" id="d30"></div><div class="readout" id="d30RO">&nbsp;</div></section>` +
    `<section class="card"><div class="cal-head"><button class="icon-btn" type="button" data-go="#/history/${prevM}" aria-label="上个月">${IC.left}</button><h2>${y} 年 ${m} 月</h2><button class="icon-btn" type="button" data-go="#/history/${nextM}" aria-label="下个月" ${nextM > tk.slice(0, 7) ? 'disabled' : ''}>${IC.right}</button></div>${cal}</section>`;
  drawDays30();
  root.querySelectorAll('[data-metric]').forEach(b => b.addEventListener('click', () => { histMetric = b.dataset.metric; root.querySelectorAll('[data-metric]').forEach(x => x.setAttribute('aria-pressed', String(x === b))); drawDays30(); }));
}
function drawDays30() {
  const el = $('#d30'); if (!el) return;
  const tk = todayKey();
  const M = { dist: { v: d => d.dist / 1000, goal: +S.goalKm || 2, f: v => v.toFixed(2) + ' km', c: 'var(--r-dist)' }, min: { v: d => actMin(d), goal: +S.goalMin || 60, f: v => Math.round(v) + ' 分钟', c: 'var(--r-min)' }, walks: { v: d => d.walks.length, goal: +S.goalWalks || 2, f: v => v + ' 次', c: 'var(--r-walk)' } }[histMetric];
  const rows = []; for (let i = 29; i >= 0; i--) { const k = addDays(tk, -i); rows.push({ k, has: hasData(k), v: hasData(k) ? M.v(dayOf(k)) : 0 }); }
  const W = Math.max(280, el.clientWidth), H = 160, pl = 30, pr = 30, pt = 10, pb = 22;
  const vmax = niceMax(Math.max(M.goal * 1.15, ...rows.map(r => r.v)));
  const bw = (W - pl - pr) / 30, w = Math.min(10, bw - 2);
  const Y = v => pt + (1 - v / vmax) * (H - pt - pb);
  let g = `<svg viewBox="0 0 ${W} ${H}" height="${H}" role="img" aria-label="最近 30 天"><g class="axis">`;
  [0, vmax / 2, vmax].forEach((v, i) => { const y = Y(v); g += `<line x1="${pl}" x2="${W - pr}" y1="${y}" y2="${y}" class="${i ? 'gridl' : 'basel'}"/><text x="${pl - 5}" y="${y + 4}" text-anchor="end">${+v.toFixed(2)}</text>`; });
  [29, 15, 0].forEach(i => { const r = rows[29 - i]; g += `<text x="${pl + bw * (29 - i) + bw / 2}" y="${H - 5}" text-anchor="middle">${i === 0 ? '今天' : mdKey(r.k).replace('月', '/').replace('日', '')}</text>`; });
  g += `</g>`;
  rows.forEach((r, i) => {
    const x = pl + bw * i + (bw - w) / 2;
    if (!r.has) { g += `<circle cx="${x + w / 2}" cy="${Y(0) - 3}" r="1.5" style="fill:var(--line-2)"/>`; return; }
    if (r.v <= 0) return;
    const y = Y(r.v), hh = Y(0) - y, rr = Math.min(3, hh, w / 2);
    g += `<path d="M${x} ${Y(0)}V${y + rr}Q${x} ${y} ${x + rr} ${y}H${x + w - rr}Q${x + w} ${y} ${x + w} ${y + rr}V${Y(0)}Z" style="fill:${M.c};${r.v >= M.goal ? '' : 'fill-opacity:.55'}"/>`;
  });
  const gy = Y(M.goal);
  g += `<line x1="${pl}" x2="${W - pr}" y1="${gy}" y2="${gy}" style="stroke:var(--ink-2)" stroke-width="1"/><text x="${W - pr + 4}" y="${gy + 4}" class="axis" style="fill:var(--ink-2);font-size:11px">目标</text>`;
  g += `<rect id="dHit" x="${pl}" y="0" width="${W - pl - pr}" height="${H}" fill="transparent"/></svg>`;
  el.innerHTML = g;
  const ro = $('#d30RO');
  const show = ev => { const r = el.firstChild.getBoundingClientRect(); const i = Math.max(0, Math.min(29, Math.floor(((ev.clientX - r.left) / r.width * W - pl) / bw))); const row = rows[i]; ro.innerHTML = `<b>${mdKey(row.k)} ${wdKey(row.k)}</b>　${row.has ? M.f(row.v) + (row.v >= M.goal ? ' · 达标' : '') : '没有数据'}`; };
  const hit = $('#dHit', el); hit.addEventListener('pointermove', show); hit.addEventListener('pointerdown', show); hit.addEventListener('pointerleave', () => { ro.innerHTML = '&nbsp;'; });
  hit.addEventListener('click', ev => { const r = el.firstChild.getBoundingClientRect(); const i = Math.max(0, Math.min(29, Math.floor(((ev.clientX - r.left) / r.width * W - pl) / bw))); if (rows[i].has) location.hash = '#/today/' + rows[i].k; });
}

// ---------- view: all walks ----------
function viewWalks() {
  const acts = D.acts;
  let body = '';
  if (!acts.length) body = `<div class="card empty"><b>还没有运动记录。</b>遛 ${esc(S.name)} 时在 Tractive 里打开 LIVE，回家后导出 GPX 再导入这里。</div>`;
  const groups = new Map();
  for (const a of acts) { const k = dayKey(a.start).slice(0, 7); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(a); }
  for (const [k, list] of groups) {
    const [y, m] = k.split('-').map(Number);
    body += `<h2 class="sec-title">${y} 年 ${m} 月<small>${list.length} 次 · ${distText(list.reduce((s, a) => s + a.distance, 0))} · ${durText(list.reduce((s, a) => s + a.movingTime, 0))}</small></h2><div class="list">${list.map(walkRow).join('')}</div>`;
  }
  root.innerHTML = banners() + head(`${S.name} 的记录`, '运动', importBtnFn()) + body;
}

// ---------- view: one walk ----------
function viewWalk(id) {
  const a = D.byId.get(String(id));
  if (!a) { root.innerHTML = `<button class="back" type="button" data-go="#/walks">${IC.left}运动</button><div class="card empty" style="margin-top:14px">找不到这条记录，可能已经删除了。</div>`; return; }
  const dense = a.live && a.denseShare > 0.5;
  const kc = E.kcal(a.distance, +S.weight);
  const pauseTot = a.pauses.reduce((s, p) => s + p.dur, 0), longest = a.pauses.reduce((m, p) => Math.max(m, p.dur), 0);
  const zt = a.zoneTime, mv = zt.slice(1).reduce((s, x) => s + x, 0) || 1, domZ = zt.slice(1).indexOf(Math.max(...zt.slice(1))) + 1;
  let lede;
  if (dense) {
    const fb = feats(a).bursts;
    lede = (fb >= 3 ? `快跑了 ${fb} 次（每次超过 ${Math.round(E.CFG.sprintV * SPK())} ${spU()}），` : '') + `大部分时间在${E.ZONES[domZ].name}（占移动时间 ${Math.round(zt[domZ] / mv * 100)}%）`;
    lede += a.pauses.length ? `，途中停下 ${a.pauses.length} 次，最长一次 ${durText(longest)}。` : '，途中没有明显停顿。';
    if (a.vehicleTime) lede += `另有 ${durText(a.vehicleTime)} 在乘车，已从距离和速度里剔除。`;
  } else lede = '这段只有常规定位，点和点之间隔了好几分钟，距离按直线估算，通常比实际走的少，速度和步态只是粗略估计。';
  if (a.afterCar || a.beforeCar) lede += `${a.afterCar && a.beforeCar ? '前后' : a.afterCar ? '之前' : '之后'}坐车的部分已经去掉，只算 ${S.name} 自己走的。`;
  const key = dayKey(a.start);
  const stat = (l, v, s) => `<div><div class="l">${l}</div><div class="v">${v}</div><div class="s">${s}</div></div>`;
  root.innerHTML = `<button class="back" type="button" data-back="#/today/${key}">${IC.left}返回</button>` +
    `<header class="head"><div style="min-width:0"><div class="eyebrow">${esc(`${mdKey(key)} ${wdKey(key)} · ${hm(a.start)}–${hm(a.end)}`)}</div><h1 data-aname="${a.start}">${esc(actName(a))}</h1></div><div class="acts"><button class="icon-btn" type="button" id="renameBtn" aria-label="改名">${IC.edit}</button></div></header>` +
    `<p class="where" data-aplace="${a.start}">${placeLine(a)}</p>` +
    `<span class="pill ${dense ? '' : 'warn'}"><i></i>${dense ? `LIVE · 约 ${Math.round(a.denseMedianDt)} 秒一个点` : `常规定位 · 约 ${Math.round(a.medianDt / 60)} 分钟一个点`}</span>
    ${recBadges(a)}<p class="lede">${esc(lede)}</p>
    <section class="card"><div class="stats big">
      ${stat('距离', distHTML(a.distance), a.rawDistance > a.distance * 1.08 ? `原始点直接连线 ${distText(a.rawDistance)}，差值是定位抖动` : '&nbsp;')}
      ${stat('运动时间', durHTML(a.movingTime), `总时长 ${durText(a.duration)}`)}
      ${stat('平均速度', spdHTML(a.avgMoving), `配速 ${pace(a.avgMoving)} /km`)}
      ${stat('最高速度', spdHTML(a.maxV), a.maxAt ? `在 ${hms(a.maxAt)}` : '&nbsp;')}
      ${stat('途中停顿', `${a.pauses.length}<span class="u">次</span>`, a.pauses.length ? `共 ${durText(pauseTot)}` : '停 10 秒以上才算')}
      ${stat('活动消耗', kc != null ? `≈${Math.max(1, Math.round(kc))}<span class="u">千卡</span>` : '—', kc != null ? `按 ${S.weight} kg 估算` : '<button type="button" data-go="#/settings">填写体重</button>后显示')}
      ${stat('海拔变化', a.elev ? `+${Math.round(a.elev.gain)}<span class="u">m</span>` : '—', a.elev ? 'GPS 估算，误差大' : '没有海拔数据')}
    </div></section>
    <section class="card" style="padding:8px"><div class="map" id="wMap"></div></section>
    <section class="card"><h2>速度</h2><p class="hint">曲线经过平滑，冲刺的尖峰会被削低；圆点是实测最快的 4 秒。手指在图上左右滑动，地图上会标出 ${esc(S.name)} 当时的位置</p><div class="chart" id="speed"></div><div class="readout" id="speedRO">&nbsp;</div>
      <div class="legend">${E.ZONES.map((z, i) => `<span><i class="line" style="background:${ZC[i]}"></i>${z.name}</span>`).join('')}${a.vehicleTime ? '<span><i class="line" style="background:var(--veh)"></i>乘车</span>' : ''}</div></section>
    <section class="card"><h2>步态分布</h2><p class="hint">各速度区间累计的时间（${spU()}）</p>${zonesHTML(a)}</section>
    <section class="card"><h2>分段</h2><p class="hint">每 ${a.splitLen >= 1000 ? a.splitLen / 1000 + ' km' : a.splitLen + ' m'} 一段，用时包含停顿</p>${splitsHTML(a)}</section>`;
  $('#renameBtn').addEventListener('click', () => renameBox(a));
  let mapApi = null;
  createMap($('#wMap'), a).then(m => { mapApi = m; if (m) cleanup.push(() => m.destroy()); });
  drawSpeed(a, q => mapApi && mapApi.hover(q));
}
function zonesHTML(a) {
  const zt = a.zoneTime, tot = zt.reduce((s, x) => s + x, 0) || 1, mx = Math.max(...zt) || 1;
  const rng = i => { const K = SPK(), lo = E.ZONES[i].min * K, hi = E.ZONES[i + 1] ? E.ZONES[i + 1].min * K : null; return i === 0 ? `< ${hi.toFixed(1)}` : hi ? `${lo.toFixed(1)}–${hi.toFixed(1)}` : `> ${lo.toFixed(1)}`; };
  return E.ZONES.map((z, i) => `<div class="zrow"><div class="nm">${z.name}<small>${rng(i)}</small></div><div class="bar"><i style="width:${(zt[i] / mx * 100).toFixed(1)}%;background:${ZC[i]}"></i></div><div class="val"><b>${durText(zt[i])}</b> · ${Math.round(zt[i] / tot * 100)}%</div></div>`).join('') +
    (a.vehicleTime ? `<div class="zrow"><div class="nm">乘车</div><div class="bar"><i style="width:${Math.min(100, a.vehicleTime / mx * 100).toFixed(1)}%;background:var(--veh)"></i></div><div class="val"><b>${durText(a.vehicleTime)}</b></div></div>` : '');
}
function splitsHTML(a) {
  if (!a.splits.length) return '<p class="hint" style="margin:0">距离太短，分不出段。</p>';
  const vs = a.splits.map(s => s.dist / s.dur), vmax = Math.max(...vs);
  return `<table><thead><tr><th>段</th><th>距离</th><th>用时</th><th>配速</th><th class="barc">速度</th></tr></thead><tbody>${a.splits.map((s, i) => `<tr class="${s.partial ? 'partial' : ''}"><td>${s.k}</td><td>${distText(s.dist)}</td><td>${clock(s.dur)}</td><td>${pace(vs[i])}</td><td class="barc"><i style="width:${(vs[i] / vmax * 100).toFixed(1)}%"></i></td></tr>`).join('')}</tbody></table>`;
}
function drawSpeed(a, onHover) {
  const el = $('#speed'); if (!el) return;
  const W = Math.max(280, el.clientWidth), H = 200, pl = 30, pr = 34, pt = 20, pb = 24;
  const s = a.samples, t0 = s[0].t, t1 = s[s.length - 1].t, K = SPK();
  const vmax = Math.max(5, niceMax(Math.max(a.maxV, ...s.filter(q => !q.vehicle).map(q => q.v)) * K * 1.1));
  const X = t => pl + (t - t0) / Math.max(1, t1 - t0) * (W - pl - pr);
  const Y = v => pt + (1 - Math.min(v * K, vmax) / vmax) * (H - pt - pb);
  let g = `<svg viewBox="0 0 ${W} ${H}" height="${H}" role="img" aria-label="速度曲线"><g class="axis">`;
  const ts = vmax <= 6 ? 1 : vmax <= 12 ? 2 : vmax <= 25 ? 5 : 10;
  for (let v = 0; v <= vmax + 1e-6; v += ts) { const y = Y(v / K); g += `<line x1="${pl}" x2="${W - pr}" y1="${y}" y2="${y}" class="${v ? 'gridl' : 'basel'}"/><text x="${pl - 5}" y="${y + 4}" text-anchor="end">${v}</text>`; }
  g += `<text x="${pl - 5}" y="9" text-anchor="end" style="font-size:10px">${spU()}</text>`;
  E.ZONES.forEach((z, i) => {
    if (!i) return; const lo = z.min * K, hi = Math.min(vmax, (E.ZONES[i + 1] ? E.ZONES[i + 1].min : 99) * K);
    if (lo >= vmax || Y(lo / K) - Y(hi / K) < 13) return;
    g += `<text x="${W - pr + 4}" y="${(Y(lo / K) + Y(hi / K)) / 2 + 4}" style="font-size:10.5px">${z.name}</text>`;
  });
  const dur = (t1 - t0) / 1000;
  const xs = [60, 120, 300, 600, 900, 1800, 3600, 7200].find(q => dur / q <= Math.max(2, (W - pl) / 80)) || 7200;
  for (let t = Math.ceil(t0 / (xs * 1000)) * xs * 1000; t <= t1; t += xs * 1000) { const x = X(t); if (x < pl + 14 || x > W - pr - 14) continue; g += `<text x="${x}" y="${H - 6}" text-anchor="middle">${hm(t)}</text>`; }
  g += `</g>`;
  let area = `M${X(t0)} ${Y(0)}`; for (const q of s) area += `L${X(q.t).toFixed(1)} ${Y(q.vehicle ? 0 : q.v).toFixed(1)}`; area += `L${X(t1)} ${Y(0)}Z`;
  g += `<path d="${area}" style="fill:var(--r-walk);fill-opacity:.08"/>`;
  let run = '', cls = null;
  const flush = () => { if (run && cls) { const [z, sp] = cls.split('|'); g += `<path d="${run}" fill="none" style="stroke:${zoneColor(+z)}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"${sp === 's' ? ' stroke-dasharray="3 4"' : ''}/>`; } };
  for (let i = 1; i < s.length; i++) {
    const q = s[i], p = s[i - 1], c = `${q.vehicle ? -2 : Math.max(0, q.zone)}|${q.dense ? 'd' : 's'}`;
    if (q.zone === -1) { flush(); run = ''; cls = null; continue; }
    if (c !== cls) { flush(); run = `M${X(p.t).toFixed(1)} ${Y(p.vehicle ? 0 : p.v).toFixed(1)}`; cls = c; }
    run += `L${X(q.t).toFixed(1)} ${Y(q.vehicle ? 0 : q.v).toFixed(1)}`;
  }
  flush();
  // the curve is smoothed; the dot marks the measured top speed, which can sit above it
  if (a.maxAt) { const x = X(a.maxAt), y = Y(a.maxV); g += `<circle cx="${x}" cy="${y}" r="4" style="fill:var(--ink);stroke:var(--surface)" stroke-width="2"/><text x="${Math.min(W - pr - 52, x + 7)}" y="${Math.max(pt + 2, y - 7)}" style="fill:var(--ink-2);font-size:11px">最高 ${spd(a.maxV)}</text>`; }
  g += `<line id="sX" y1="${pt}" y2="${H - pb}" style="display:none;stroke:var(--ink-2)" stroke-width="1"/><circle id="sDot" r="4.5" style="display:none;fill:var(--ink);stroke:var(--surface)" stroke-width="2"/>`;
  g += `<rect id="sHit" x="${pl}" y="0" width="${W - pl - pr}" height="${H}" fill="transparent"/></svg>`;
  el.innerHTML = g;
  const svg = el.firstChild, xl = $('#sX', el), dot = $('#sDot', el), ro = $('#speedRO');
  const move = ev => {
    const r = svg.getBoundingClientRect(); const t = t0 + ((ev.clientX - r.left) / r.width * W - pl) / (W - pl - pr) * (t1 - t0);
    const q = s[bisect(s, t)], x = X(q.t), y = Y(q.vehicle ? 0 : q.v), z = q.vehicle ? -2 : q.zone;
    xl.setAttribute('x1', x); xl.setAttribute('x2', x); xl.style.display = ''; dot.setAttribute('cx', x); dot.setAttribute('cy', y); dot.style.display = '';
    ro.innerHTML = `<b>${q.vehicle ? '乘车' : spdText(q.v)}</b>　${zoneName(z)} · ${hms(q.t)} · 已走 ${distText(q.d)}`;
    onHover(q);
  };
  const leave = () => { xl.style.display = 'none'; dot.style.display = 'none'; ro.innerHTML = '&nbsp;'; onHover(null); };
  const hit = $('#sHit', el);
  hit.addEventListener('pointermove', move); hit.addEventListener('pointerdown', move); hit.addEventListener('pointerleave', leave); hit.addEventListener('pointercancel', leave);
}

// ---------- maps: free (Esri via Leaflet) or Google ----------
const BASES = {
  map: { url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', attr: '底图 © Esri 及数据提供方', maxNative: 18 },
  sat: { url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', attr: '影像 © Esri, Maxar, Earthstar Geographics', maxNative: 19 },
};
const baseSwitch = () => `<button type="button" data-base="map" aria-pressed="${S.base !== 'sat'}">地图</button><button type="button" data-base="sat" aria-pressed="${S.base === 'sat'}">卫星</button>`;
async function createMap(el, a) {
  if (!el) return null;
  if (S.mapProvider === 'google' && S.gkey) {
    try { return await googleMap(el, a); }
    catch (e) { toast(`Google 地图没加载成功（${e.message}），先用免费地图`); el.innerHTML = ''; }
  }
  return leafletMap(el, a);
}
function leafletMap(el, a) {
  if (!window.L) { el.innerHTML = '<div class="fallback">地图组件没有加载成功。</div>'; return null; }
  const map = L.map(el, { zoomSnap: 0.5, maxZoom: 20, attributionControl: true });
  map.attributionControl.setPrefix(false);
  let tiles = null, slowT = null;
  const note = text => {
    let n = el.querySelector('.note');
    if (!text) { if (n) n.remove(); el.classList.remove('no-tiles'); return; }
    el.classList.add('no-tiles'); if (!n) { n = document.createElement('div'); n.className = 'note'; el.appendChild(n); } n.textContent = text;
  };
  const setTiles = () => {
    const B = BASES[S.base === 'sat' ? 'sat' : 'map'];
    if (tiles) map.removeLayer(tiles);
    clearTimeout(slowT); note(null);
    el.classList.toggle('base-map', S.base !== 'sat');
    tiles = L.tileLayer(B.url, { maxNativeZoom: B.maxNative, maxZoom: 20, attribution: B.attr, crossOrigin: 'anonymous' }).addTo(map);
    let ok = 0, bad = 0;
    tiles.on('tileload', () => { ok++; clearTimeout(slowT); note(null); });
    tiles.on('tileerror', () => { bad++; if (!ok && bad >= 2) note('底图加载失败，只显示轨迹形状（离线或网络受限）'); });
    slowT = setTimeout(() => { if (!ok) note('底图还没加载出来，先只显示轨迹形状'); }, 10000);
  };
  const Sw = L.Control.extend({ onAdd() {
    const d = L.DomUtil.create('div', 'basesw'); d.innerHTML = baseSwitch();
    L.DomEvent.disableClickPropagation(d);
    d.addEventListener('click', e => { const b = e.target.closest('[data-base]'); if (!b) return; S.base = b.dataset.base; saveSettings(); d.querySelectorAll('[data-base]').forEach(x => x.setAttribute('aria-pressed', String(x === b))); setTiles(); });
    return d;
  } });
  new Sw({ position: 'topright' }).addTo(map);
  setTiles();
  const ll = a.samples.map(s => [s.lat, s.lon]);
  L.polyline(ll, { className: 'trk casing', weight: 8, interactive: false }).addTo(map);
  for (const r of runs(a.samples)) L.polyline(r.pts.map(s => [s.lat, s.lon]), { className: 'trk ' + r.cls, weight: 5, interactive: false }).addTo(map);
  const s0 = a.samples[0], s1 = a.samples[a.samples.length - 1];
  L.circleMarker([s1.lat, s1.lon], { radius: 6, weight: 2, className: 'mk-end' }).bindTooltip(`终点 ${hm(s1.t)}`, { direction: 'top' }).addTo(map);
  L.circleMarker([s0.lat, s0.lon], { radius: 6, weight: 2, className: 'mk-start' }).bindTooltip(`起点 ${hm(s0.t)}`, { direction: 'top' }).addTo(map);
  const hov = L.circleMarker([s0.lat, s0.lon], { radius: 6, weight: 3, className: 'mk-hover', interactive: false, opacity: 0, fillOpacity: 0 }).addTo(map);
  map.fitBounds(L.latLngBounds(ll), { padding: [26, 26], maxZoom: 19 });
  return {
    hover(q) { if (q) { hov.setLatLng([q.lat, q.lon]); hov.setStyle({ opacity: 1, fillOpacity: 1 }); } else hov.setStyle({ opacity: 0, fillOpacity: 0 }); },
    destroy() { clearTimeout(slowT); map.remove(); },
  };
}
// Coloured pieces of the track. Stops take the colour of the walking around them and colour flips
// shorter than a few metres are absorbed, so the line stays smooth instead of breaking into speckles.
function runs(samples) {
  const n = samples.length - 1;
  if (n < 1) return [];
  const z = [], dense = [];
  for (let i = 1; i <= n; i++) { const s = samples[i]; z.push(s.vehicle ? -2 : Math.max(0, s.zone)); dense.push(!!s.dense); }
  let last = 0; for (let k = 0; k < n; k++) { if (z[k] > 0) last = z[k]; else if (z[k] === 0 && last) z[k] = last; }
  let next = 0; for (let k = n - 1; k >= 0; k--) { if (z[k] > 0) next = z[k]; else if (z[k] === 0 && next) z[k] = next; }
  const len = (k0, k1) => { let m = 0; for (let k = k0; k <= k1; k++) m += E.hav(samples[k], samples[k + 1]); return m; };
  for (let pass = 0; pass < 2; pass++) {
    for (let k = 0; k < n;) {
      let j = k; while (j + 1 < n && z[j + 1] === z[k] && dense[j + 1] === dense[k]) j++;
      if (dense[k] && z[k] > 0 && len(k, j) < 12) {
        const fill = k > 0 && z[k - 1] > 0 ? z[k - 1] : j + 1 < n && z[j + 1] > 0 ? z[j + 1] : z[k];
        for (let q = k; q <= j; q++) z[q] = fill;
      }
      k = j + 1;
    }
  }
  const out = []; let cur = null;
  for (let k = 0; k < n; k++) {
    const cls = z[k] === -2 ? 'zv' : `z${z[k]}${dense[k] ? '' : ' zs'}`;
    if (!cur || cur.cls !== cls) { cur = { cls, zone: z[k], dense: dense[k], pts: [samples[k]] }; out.push(cur); }
    cur.pts.push(samples[k + 1]);
  }
  return out;
}
let gmPromise = null;
function loadGoogle(key) {
  if (window.google && window.google.maps && window.google.maps.Map) return Promise.resolve();
  if (gmPromise) return gmPromise;
  gmPromise = new Promise((res, rej) => {
    const t = setTimeout(() => { gmPromise = null; rej(new Error('加载超时')); }, 15000);
    window.__mioGmReady = () => { clearTimeout(t); res(); };
    window.gm_authFailure = () => { toast('Google 地图密钥无效，或者没有开通 Maps JavaScript API。已换回免费地图，可以在设置里检查密钥。'); S.mapProvider = 'esri'; saveSettings(); render(); };
    const sc = document.createElement('script');
    sc.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly&language=zh-CN&loading=async&callback=__mioGmReady`;
    sc.async = true;
    sc.onerror = () => { clearTimeout(t); gmPromise = null; rej(new Error('网络连不上 Google')); };
    document.head.appendChild(sc);
  });
  return gmPromise;
}
const GM_NIGHT = [
  { elementType: 'geometry', stylers: [{ color: '#1f1f1d' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#8f8d86' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#1a1a19' }] },
  { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#33332f' }] },
  { featureType: 'road', elementType: 'geometry.stroke', stylers: [{ color: '#262624' }] },
  { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: '#45443f' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#16222f' }] },
  { featureType: 'poi.park', elementType: 'geometry', stylers: [{ color: '#1c2a21' }] },
  { featureType: 'poi', elementType: 'labels.icon', stylers: [{ visibility: 'off' }] },
  { featureType: 'transit', stylers: [{ visibility: 'off' }] },
];
async function googleMap(el, a) {
  await loadGoogle(S.gkey);
  const g = google.maps;
  const typeId = () => S.base === 'sat' ? 'hybrid' : 'roadmap';
  const map = new g.Map(el, {
    mapTypeId: typeId(), disableDefaultUI: true, zoomControl: true, fullscreenControl: true, gestureHandling: 'cooperative', clickableIcons: false,
    styles: isDark() ? GM_NIGHT : null, backgroundColor: cssVar('--bg'), maxZoom: 21,
  });
  const sw = document.createElement('div'); sw.className = 'basesw'; sw.style.margin = '10px'; sw.innerHTML = baseSwitch();
  sw.addEventListener('click', e => { const b = e.target.closest('[data-base]'); if (!b) return; S.base = b.dataset.base; saveSettings(); sw.querySelectorAll('[data-base]').forEach(x => x.setAttribute('aria-pressed', String(x === b))); map.setMapTypeId(typeId()); });
  map.controls[g.ControlPosition.TOP_LEFT].push(sw);
  const ll = s => ({ lat: s.lat, lng: s.lon });
  const col = { '-2': cssVar('--veh'), 0: cssVar('--z0'), 1: cssVar('--z1'), 2: cssVar('--z2'), 3: cssVar('--z3'), 4: cssVar('--z4') };
  new g.Polyline({ map, path: a.samples.map(ll), strokeColor: '#000000', strokeOpacity: isDark() ? 0.6 : 0.38, strokeWeight: 9, clickable: false, zIndex: 1 });
  for (const r of runs(a.samples)) {
    const c = col[r.zone] || col[1];
    const dashed = r.zone === -2;
    new g.Polyline({
      map, path: r.pts.map(ll), clickable: false, zIndex: 2, strokeColor: c, strokeWeight: 5, strokeOpacity: dashed ? 0 : r.dense ? 1 : 0.5,
      icons: dashed ? [{ icon: { path: 'M 0,-1 0,1', strokeOpacity: 1, strokeColor: c, scale: 3 }, offset: '0', repeat: '12px' }] : undefined,
    });
  }
  const dot = (s, fill, stroke, scale, title, z = 3) => new g.Marker({ map, position: ll(s), title, clickable: !!title, zIndex: z, icon: { path: g.SymbolPath.CIRCLE, scale, fillColor: fill, fillOpacity: 1, strokeColor: stroke, strokeWeight: 2 } });
  const surf = cssVar('--surface'), ink = cssVar('--ink'), acc = cssVar('--accent');
  const s0 = a.samples[0], s1 = a.samples[a.samples.length - 1];
  dot(s1, ink, surf, 6, `终点 ${hm(s1.t)}`); dot(s0, acc, surf, 6, `起点 ${hm(s0.t)}`);
  const hov = dot(s0, ink, surf, 6, '', 9); hov.setVisible(false);
  const b = new g.LatLngBounds(); a.samples.forEach(s => b.extend(ll(s)));
  map.fitBounds(b, 30);
  g.event.addListenerOnce(map, 'idle', () => { if (map.getZoom() > 19) map.setZoom(19); });
  return { hover(q) { if (q) { hov.setPosition(ll(q)); hov.setVisible(true); } else hov.setVisible(false); }, destroy() { g.event.clearInstanceListeners(map); } };
}

// ---------- records: personal bests and fun facts, from every activity on the phone ----------
let recCache = null;
function records() {
  if (recCache && recCache.acts === D.acts) return recCache;
  const live = D.acts.filter(a => a.live), walks = D.acts.filter(isWalk);
  const top = (list, val) => { let best = null, bv = 0; for (const a of list) { const v = val(a); if (v > bv) { bv = v; best = a; } } return best ? { a: best, v: bv } : null; };
  const sprintsOf = a => a.sprints || [];
  let longSprint = null;
  for (const a of live) for (const sp of sprintsOf(a)) if (!longSprint || sp.dist > longSprint.sp.dist) longSprint = { a, sp };
  const runDist = a => sprintsOf(a).reduce((s, x) => s + x.dist, 0);
  const R = {
    acts: D.acts,
    speed: top(live, a => a.maxV),
    fastest3: live.filter(a => a.maxV > 0).sort((x, y) => y.maxV - x.maxV).slice(0, 3),
    sprint: longSprint,
    farthest: top(walks, a => a.distance),
    longest: top(walks, a => a.movingTime),
    running: top(live, runDist),
    mostSprints: top(live, a => sprintsOf(a).length),
  };
  // best day and streaks of days with at least one walk
  let bestDay = null;
  for (const d of D.days.values()) if (d.dist > 0 && (!bestDay || d.dist > bestDay.dist)) bestDay = d;
  R.bestDay = bestDay;
  const wdays = [...D.days.values()].filter(d => d.walks.length).map(d => d.key).sort();
  let streak = 0, run = 0, prev = null;
  for (const k of wdays) { run = prev && addDays(prev, 1) === k ? run + 1 : 1; streak = Math.max(streak, run); prev = k; }
  const tk = todayKey();
  let now = 0; for (let k = wdays.includes(tk) ? tk : addDays(tk, -1); wdays.includes(k); k = addDays(k, -1)) now++;
  R.streak = streak; R.streakNow = now;
  // totals
  const sp = live.flatMap(sprintsOf);
  R.tot = { n: walks.length, dist: walks.reduce((s, a) => s + a.distance, 0), sec: walks.reduce((s, a) => s + a.movingTime, 0), sprints: sp.length, sprintDist: sp.reduce((s, x) => s + x.dist, 0), since: D.acts.length ? D.acts[D.acts.length - 1].start : null };
  // when Mio goes out
  const SLOTS = [[5, '清晨'], [8, '上午'], [11, '中午'], [14, '下午'], [17, '傍晚'], [19, '晚上'], [24, '深夜']];
  const slotOf = t => { const h = hourOf(t); return h < 5 ? '深夜' : SLOTS.find(([e]) => h < e)[1]; };
  const slots = new Map(); walks.forEach(a => slots.set(slotOf(a.start), (slots.get(slotOf(a.start)) || 0) + 1));
  R.slot = [...slots].sort((x, y) => y[1] - x[1])[0] || null;
  const tod = t => { const d = LD(t); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
  R.earliest = top(walks, a => 1440 - tod(a.start)); R.latest = top(walks, a => tod(a.end) < 240 ? 1440 + tod(a.end) : tod(a.end));
  return (recCache = R);
}
// which records this activity holds (shown on its own page)
function recBadges(a) {
  const R = records(), out = [];
  if (R.speed && R.speed.a === a) out.push('最快速度');
  if (R.sprint && R.sprint.a === a) out.push('最长冲刺');
  if (R.farthest && R.farthest.a === a) out.push('最远一次');
  if (R.longest && R.longest.a === a) out.push('最久一次');
  if (R.running && R.running.a === a) out.push('跑得最多');
  if (R.mostSprints && R.mostSprints.a === a) out.push('冲刺最多');
  return out.length ? `<span class="pill gold">${IC.trophy}纪录：${out.join(' · ')}</span>` : '';
}
// small drawings for the records page
function fitter(samples, W, H, pad) {
  const k = Math.cos(samples[0].lat * Math.PI / 180);
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const p of samples) { const x = p.lon * k, y = -p.lat; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  const sc = Math.min((W - 2 * pad) / Math.max(x1 - x0, 1e-7), (H - 2 * pad) / Math.max(y1 - y0, 1e-7));
  const ox = W / 2 - (x1 + x0) / 2 * sc, oy = H / 2 - (y1 + y0) / 2 * sc;
  return p => [p.lon * k * sc + ox, -p.lat * sc + oy];
}
const pathOf = (pts, f, maxN = 300) => { const st = Math.max(1, Math.floor(pts.length / maxN)); return pts.filter((_, i) => i % st === 0 || i === pts.length - 1).map((p, i) => { const [x, y] = f(p); return `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`; }).join(''); };
const inSpan = (a, t0, t1) => a.samples.filter(q => q.t >= t0 && q.t <= t1);
function vizRoute(a, sprints, W = 300, H = 150) {
  // the whole outing as a line; with sprints, a faint line and the fast stretches drawn on top
  const f = fitter(a.samples, W, H, 8);
  let g = `<path d="${pathOf(a.samples, f)}" fill="none" style="stroke:var(--c)" stroke-opacity="${sprints ? .25 : 1}" stroke-width="${sprints ? 1.8 : 2.6}" stroke-linejoin="round" stroke-linecap="round"/>`;
  if (sprints) for (const sp of sprints) { const s = inSpan(a, sp.t0, sp.t1); if (s.length > 1) g += `<path d="${pathOf(s, f)}" fill="none" style="stroke:var(--c)" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>`; }
  else { const [x, y] = f(a.samples[0]); g += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4.5" style="fill:var(--c);stroke:var(--tile)" stroke-width="2"/>`; }
  return `<svg class="route" viewBox="0 0 ${W} ${H}" aria-hidden="true">${g}</svg>`;
}
function vizSprint(a, sp, W = 300, H = 150) {
  const s = inSpan(a, sp.t0, sp.t1); if (s.length < 2) return '';
  const f = fitter(s, W, H, 14), [x0, y0] = f(s[0]), [x1, y1] = f(s[s.length - 1]);
  return `<svg class="route" viewBox="0 0 ${W} ${H}" aria-hidden="true"><path d="${pathOf(s, f)}" fill="none" style="stroke:var(--c)" stroke-width="4" stroke-linejoin="round" stroke-linecap="round"/><circle cx="${x0.toFixed(1)}" cy="${y0.toFixed(1)}" r="5" style="fill:var(--tile);stroke:var(--c)" stroke-width="2.5"/><circle cx="${x1.toFixed(1)}" cy="${y1.toFixed(1)}" r="6" style="fill:var(--c)"/></svg>`;
}
function vizClock(sec) {
  const r = 22, C = 2 * Math.PI * r, f = Math.min(1, sec / 3600), f2 = Math.max(0, Math.min(1, sec / 3600 - 1));
  let ticks = '';
  for (let i = 0; i < 12; i++) { const an = i / 12 * 2 * Math.PI, r1 = i % 3 ? 15.5 : 12.5; ticks += `<line x1="${(30 + Math.sin(an) * 14).toFixed(1)}" y1="${(30 - Math.cos(an) * 14).toFixed(1)}" x2="${(30 + Math.sin(an) * r1).toFixed(1)}" y2="${(30 - Math.cos(an) * r1).toFixed(1)}" style="stroke:var(--muted)" stroke-width="${i % 3 ? 1 : 1.6}" stroke-linecap="round"/>`; }
  return `<svg class="clock" viewBox="0 0 60 60" aria-hidden="true"><circle cx="30" cy="30" r="${r}" fill="none" style="stroke:var(--c)" stroke-opacity=".18" stroke-width="7"/><circle cx="30" cy="30" r="${r}" fill="none" style="stroke:var(--c)" stroke-width="7" stroke-linecap="round" stroke-dasharray="${(C * f).toFixed(1)} ${C.toFixed(1)}" transform="rotate(-90 30 30)"/>${f2 ? `<circle cx="30" cy="30" r="${r}" fill="none" style="stroke:var(--ink)" stroke-opacity=".5" stroke-width="3" stroke-dasharray="${(C * f2).toFixed(1)} ${C.toFixed(1)}" transform="rotate(-90 30 30)"/>` : ''}${ticks}</svg>`;
}
const vizDots = n => `<div class="dots" aria-hidden="true">${'<i></i>'.repeat(Math.min(n, 100))}${n > 100 ? `<b>+${n - 100}</b>` : ''}</div>`;
function vizStreak() {
  const tk = todayKey(); let h = '<div class="streak" aria-hidden="true">';
  for (let i = 27; i >= 0; i--) { const k = addDays(tk, -i), on = dayOf(k).walks.length > 0; h += `<i class="${on ? 'on' : ''}${k === tk ? ' today' : ''}"></i>`; }
  return h + '</div><div class="streak-l"><span>四周前</span><span>今天</span></div>';
}
// speedometer: the record on a dial, with a human jog and Usain Bolt's 100 m average for scale
function gauge(v) {
  const K = SPK(), unit = spU(), JOG = 2.78, BOLT = 100 / 9.58;
  const top = Math.max(11.12, v * 1.15), stepU = unit === 'mph' ? 5 : 10;
  const W = 300, H = 160, cx = 150, cy = 148, r = 118;
  const ang = x => Math.PI * (1 - Math.min(x, top) / top);
  const P = (x, rr) => [cx + Math.cos(ang(x)) * rr, cy - Math.sin(ang(x)) * rr];
  const f1 = n => n.toFixed(1);
  const arc = (a, b, rr) => { const [x0, y0] = P(a, rr), [x1, y1] = P(b, rr); return `M${f1(x0)} ${f1(y0)}A${rr} ${rr} 0 0 1 ${f1(x1)} ${f1(y1)}`; };
  let g = `<path d="${arc(0, top, r)}" fill="none" stroke="rgba(255,255,255,.16)" stroke-width="16" stroke-linecap="round"/>`;
  g += `<path d="${arc(0, v, r)}" fill="none" stroke="url(#gGold)" stroke-width="16" stroke-linecap="round"/>`;
  for (let u = 0; u <= top * K + 1e-6; u += stepU) {
    const x = u / K, [a, b] = P(x, r - 14), [c, d] = P(x, r - 21), [tx, ty] = P(x, r - 33);
    g += `<line x1="${f1(a)}" y1="${f1(b)}" x2="${f1(c)}" y2="${f1(d)}" stroke="rgba(255,255,255,.45)" stroke-width="1.5" stroke-linecap="round"/><text x="${f1(tx)}" y="${f1(ty + 4)}" text-anchor="middle" fill="rgba(255,255,255,.6)" font-size="11">${u}</text>`;
  }
  const mark = (x, label) => {
    if (x > top) return '';
    const [a, b] = P(x, r + 11), [c, d] = P(x, r - 9), [tx, ty] = P(x, r + 21);
    const anc = x / top < .4 ? 'end' : x / top > .6 ? 'start' : 'middle';
    return `<line x1="${f1(a)}" y1="${f1(b)}" x2="${f1(c)}" y2="${f1(d)}" stroke="#fff" stroke-width="2" stroke-linecap="round"/><text x="${f1(tx)}" y="${f1(ty + 3)}" text-anchor="${anc}" fill="rgba(255,255,255,.85)" font-size="11">${label}</text>`;
  };
  g += mark(JOG, '人慢跑') + mark(BOLT, '博尔特');
  const [nx, ny] = P(v, r - 42);
  g += `<line x1="${cx}" y1="${cy}" x2="${f1(nx)}" y2="${f1(ny)}" stroke="#fff" stroke-width="3" stroke-linecap="round"/><circle cx="${cx}" cy="${cy}" r="6" fill="#fff"/>`;
  return `<svg class="gauge" viewBox="-30 -26 ${W + 60} ${H + 30}" role="img" aria-label="最快速度 ${spdText(v)}"><defs><linearGradient id="gGold" x1="0" x2="1"><stop offset="0" stop-color="#f7d774"/><stop offset="1" stop-color="#f0a83a"/></linearGradient></defs>${g}</svg>`;
}
function dial24(walks) {
  // every outing as an arc on a 24-hour clock, midnight at the top
  const S0 = 200, c = S0 / 2, r = 70, TAU = 2 * Math.PI;
  const an = t => { const d = LD(t); return (d.getUTCHours() + d.getUTCMinutes() / 60) / 24 * TAU; };
  const pt = (a, rr) => [c + Math.sin(a) * rr, c - Math.cos(a) * rr];
  const f1 = n => n.toFixed(1);
  let g = `<circle cx="${c}" cy="${c}" r="${r}" fill="none" style="stroke:var(--line)" stroke-width="22"/>`;
  for (const w of walks) {
    const s = an(w.start); let e = an(w.end); if (e < s) e += TAU; if (e - s < 0.05) e = s + 0.05;
    const [x0, y0] = pt(s, r), [x1, y1] = pt(e, r);
    g += `<path d="M${f1(x0)} ${f1(y0)}A${r} ${r} 0 ${e - s > Math.PI ? 1 : 0} 1 ${f1(x1)} ${f1(y1)}" fill="none" style="stroke:var(--k3)" stroke-opacity=".45" stroke-width="22"/>`;
  }
  [[0, '0 点'], [6, '6'], [12, '12'], [18, '18']].forEach(([h, l]) => { const [x, y] = pt(h / 24 * TAU, r + 23); g += `<text x="${f1(x)}" y="${f1(y + 4)}" text-anchor="middle" style="fill:var(--muted)" font-size="11">${l}</text>`; });
  return `<svg class="dial" viewBox="0 0 ${S0} ${S0}" role="img" aria-label="一天里什么时候出门">${g}</svg>`;
}

// ---------- medals ----------
// Built from HTML layers so CSS can do the metal: a conic-gradient rim (two moving highlights, like turned
// metal), a thin bevel lip, a recessed face with a sunburst finish, a soft top gloss and a tone-on-tone
// embossed number. Non-round shapes are SVG masks, so every layer follows the outline.
const PAL = {
  gold: ['#fff7da', '#e2b14d', '#8a5a14'], silver: ['#ffffff', '#c7cbd3', '#6b717d'], rose: ['#ffe9e2', '#e09a86', '#8a4636'],
  copper: ['#ffe6cf', '#e0874a', '#7a3a10'], ruby: ['#ffe0e4', '#df4b62', '#7a1428'], pink: ['#ffe6f1', '#e276ad', '#84255a'],
  amethyst: ['#f1e6ff', '#9b70e2', '#47297f'], indigo: ['#e7e8ff', '#6c70dc', '#2a2c74'], sapphire: ['#e0edff', '#4f86e2', '#1a3672'],
  sky: ['#e0f6ff', '#47a9e6', '#11507f'], teal: ['#dcfbff', '#33aec4', '#0e5664'], emerald: ['#dffbec', '#34b27e', '#0e5a3a'],
  lime: ['#effbd8', '#7dbb3e', '#2f5d12'], sun: ['#fff6d2', '#efbe45', '#8f6210'],
};
let medalN = 0;
const f1m = n => n.toFixed(2);
function roundPoly(pts, rad) {
  const n = pts.length, to = (p, q) => { const dx = q[0] - p[0], dy = q[1] - p[1], L = Math.hypot(dx, dy); return [p[0] + dx / L * rad, p[1] + dy / L * rad]; };
  let d = '';
  for (let i = 0; i < n; i++) {
    const p = pts[i], a = to(p, pts[(i - 1 + n) % n]), b = to(p, pts[(i + 1) % n]);
    d += `${i ? 'L' : 'M'}${f1m(a[0])} ${f1m(a[1])}Q${f1m(p[0])} ${f1m(p[1])} ${f1m(b[0])} ${f1m(b[1])}`;
  }
  return d + 'Z';
}
const ngon = (n, R, rot = -Math.PI / 2) => Array.from({ length: n }, (_, i) => [60 + R * Math.cos(rot + i * 2 * Math.PI / n), 60 + R * Math.sin(rot + i * 2 * Math.PI / n)]);
function sealPath(n, R, bump) {
  let d = '';
  for (let i = 0; i <= n; i++) {
    const a = -Math.PI / 2 + i * 2 * Math.PI / n, x = 60 + R * Math.cos(a), y = 60 + R * Math.sin(a);
    if (!i) { d = `M${f1m(x)} ${f1m(y)}`; continue; }
    const m = a - Math.PI / n, cx = 60 + (R + bump) * Math.cos(m), cy = 60 + (R + bump) * Math.sin(m);
    d += `Q${f1m(cx)} ${f1m(cy)} ${f1m(x)} ${f1m(y)}`;
  }
  return d + 'Z';
}
const SHAPES = {
  hex: roundPoly(ngon(6, 61), 11),
  oct: roundPoly(ngon(8, 60.5, -Math.PI / 2 + Math.PI / 8), 8),
  seal: sealPath(18, 55, 6),
};
// one stylesheet with a mask per shape
(() => {
  const css = Object.entries(SHAPES).map(([k, d]) => `.medal.sh-${k} .m-l{-webkit-mask:url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><path d="${d}"/></svg>`)}") center/100% 100% no-repeat;mask:url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><path d="${d}"/></svg>`)}") center/100% 100% no-repeat;border-radius:0}`).join('\n');
  const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
})();
function medal(o, size) {
  const L = o.locked, [hi, base, deep] = o.g || PAL.gold;
  const vs = String(o.val), n = [...vs].length, fs = n <= 2 ? 36 : n <= 3 ? 30 : n <= 4 ? 25 : 20;
  const shape = SHAPES[o.shape] ? o.shape : 'circle';
  const C = 2 * Math.PI * 47;
  const ring = L && o.prog != null ? `<svg class="m-ring" viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="47" fill="none" style="stroke:var(--line)" stroke-width="2.6"/><circle cx="50" cy="50" r="47" fill="none" style="stroke:var(--accent)" stroke-width="2.6" stroke-linecap="round" stroke-dasharray="${(C * Math.max(0.02, Math.min(1, o.prog))).toFixed(1)} ${C.toFixed(1)}" transform="rotate(-90 50 50)"/></svg>` : '';
  const style = L ? `--s:${size}px` : `--s:${size}px;--hi:${hi};--base:${base};--deep:${deep}`;
  return `<span class="medal sh-${shape}${L ? ' lk' : ''}" style="${style}" aria-hidden="true">${ring}<span class="m-coin">
    <span class="m-l m-rim"></span><span class="m-l m-lip"></span><span class="m-l m-face"></span><span class="m-l m-gloss"></span><span class="m-l m-shine"></span>
    <span class="m-glyph">${o.icon ? `<span class="m-ic">${o.icon}</span>` : ''}<b style="--fs:${fs}">${esc(vs)}</b>${o.unit ? `<i>${esc(o.unit)}</i>` : ''}</span>
  </span></span>`;
}
const awardTile = o => `<button class="award${o.locked ? ' locked' : ''}" type="button" data-award="${o.id}">${o.isNew ? '<span class="new">新</span>' : ''}${medal(o, 96)}<b>${esc(o.title)}</b><small>${o.tileSub}</small></button>`;
function awardSheet(o) {
  const d = document.createElement('dialog');
  d.className = 'awardsheet';
  d.innerHTML = `<div class="sh-medal">${medal(o, 168)}</div>
    <h3>${esc(o.title)}</h3><p class="sh-sub">${o.sub}</p>${o.desc ? `<p class="sh-desc">${o.desc}</p>` : ''}
    ${o.locked && o.prog != null ? `<div class="sh-prog"><i style="width:${(Math.min(1, o.prog) * 100).toFixed(1)}%"></i></div>` : ''}
    ${o.viz ? `<div class="sh-viz" style="--c:${o.g[1]};--tile:var(--surface)">${o.viz}</div>` : ''}
    <div class="bar">${o.go ? `<button class="btn" type="button" data-go="${o.go}">${o.goLabel || '查看这次运动'}</button>` : ''}<button class="btn secondary" type="button" data-close>好的</button></div>`;
  document.body.appendChild(d);
  d.addEventListener('click', e => { if (e.target === d || e.target.closest('[data-close],[data-go]')) { d.close(); d.remove(); } });
  d.addEventListener('cancel', () => d.remove());
  d.showModal();
}

// achievements: thresholds that unlock once, with the date they were reached
function achievements(R) {
  const fastA = (S.speedUnit === 'mph' ? 15 : 25), fastB = (S.speedUnit === 'mph' ? 20 : 30);
  const L = [
    { id: 'd5', title: '5 公里', val: '5K', icon: IC.route, shape: 'circle', g: PAL.emerald, need: 5000, k: 'dist', desc: '累计走满 5 公里。' },
    { id: 'd10', title: '10 公里', val: '10K', icon: IC.route, shape: 'circle', g: PAL.sapphire, need: 10000, k: 'dist', desc: '累计走满 10 公里。' },
    { id: 'd21', title: '半程马拉松', val: '半马', unit: '21.1K', shape: 'seal', g: PAL.amethyst, need: 21097.5, k: 'dist', desc: '累计走满一个半程马拉松（21.1 km）。' },
    { id: 'd42', title: '全程马拉松', val: '全马', unit: '42.2K', shape: 'seal', g: PAL.rose, need: 42195, k: 'dist', desc: '累计走满一个全程马拉松（42.2 km）。' },
    { id: 'd100', title: '100 公里', val: '100', unit: 'km', shape: 'oct', g: PAL.gold, need: 100000, k: 'dist', desc: '累计走满 100 公里。' },
    { id: 's100', title: '百次冲刺', val: '100', unit: '次', icon: IC.bolt, shape: 'hex', g: PAL.copper, need: 100, k: 'spr', desc: '冲刺累计 100 次。' },
    { id: 's500', title: '五百次冲刺', val: '500', unit: '次', icon: IC.bolt, shape: 'hex', g: PAL.ruby, need: 500, k: 'spr', desc: '冲刺累计 500 次。' },
    { id: 'fa', title: '一阵风', val: String(fastA), unit: spU(), icon: IC.bolt, shape: 'circle', g: PAL.sky, need: fastA / SPK(), k: 'vmax', desc: `跑出 ${fastA} ${spU()} 以上的速度。` },
    { id: 'fb', title: '闪电', val: String(fastB), unit: spU(), icon: IC.bolt, shape: 'seal', g: PAL.sun, need: fastB / SPK(), k: 'vmax', desc: `跑出 ${fastB} ${spU()} 以上的速度。` },
    { id: 'w7', title: '一周不落', val: '7', unit: '天', icon: IC.flame, shape: 'oct', g: PAL.silver, need: 7, k: 'streak', desc: '连续 7 天每天都出门运动。' },
    { id: 'w30', title: '整月不落', val: '30', unit: '天', icon: IC.flame, shape: 'oct', g: PAL.gold, need: 30, k: 'streak', desc: '连续 30 天每天都出门运动。' },
    { id: 'park', title: '狗公园常客', val: '5', unit: '次', icon: IC.paw, shape: 'circle', g: PAL.lime, need: 5, k: 'park', desc: '去狗公园玩 5 次（需要打开「自动识别地点」）。' },
    { id: 'early', title: '早起的狗', val: '7:30', unit: '之前', icon: IC.sun, shape: 'circle', g: PAL.sun, need: 1, k: 'early', desc: '早上 7:30 之前就出门运动。' },
    { id: 'night', title: '夜游', val: '21:00', unit: '之后', icon: IC.moon, shape: 'circle', g: PAL.indigo, need: 1, k: 'night', desc: '晚上 9 点以后还在外面。' },
  ];
  const st = { dist: 0, spr: 0, vmax: 0, park: 0, early: 0, night: 0, streak: 0 }, at = {};
  const tod = t => { const d = LD(t); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
  const wdays = new Set(D.acts.filter(isWalk).map(a => dayKey(a.start)));
  let run = 0, prevK = null;
  for (const a of D.acts.slice().sort((x, y) => x.start - y.start)) {
    if (isWalk(a)) {
      st.dist += a.distance;
      if (placeOf(a)?.dog) st.park++;
      const s = tod(a.start), e = tod(a.end);
      if (s >= 240 && s < 450) st.early++;
      if (e >= 1260 || (e < 240 && a.end - a.start < 6 * 3600e3)) st.night++;
      const k = dayKey(a.start);
      if (k !== prevK) { run = prevK && addDays(prevK, 1) === k && wdays.has(prevK) ? run + 1 : 1; prevK = k; st.streak = Math.max(st.streak, run); }
    }
    st.spr += (a.sprints || []).length;
    if (a.live) st.vmax = Math.max(st.vmax, a.maxV);
    for (const m of L) if (!at[m.id] && st[m.k] >= m.need) at[m.id] = a.start;
  }
  const recent = Date.now() - 3 * 86400e3;
  return L.map(m => {
    const have = st[m.k], done = !!at[m.id];
    const left = m.need - have;
    const leftTxt = m.k === 'dist' ? `还差 ${distText(left)}` : m.k === 'vmax' ? `最快 ${spdText(have)}` : m.k === 'early' || m.k === 'night' ? '还没有过' : `还差 ${Math.ceil(left)} ${m.k === 'streak' ? '天' : '次'}`;
    return { ...m, locked: !done, prog: done ? 1 : have / m.need, isNew: done && at[m.id] >= recent,
      tileSub: done ? `${mdKey(dayKey(at[m.id]))}获得` : leftTxt,
      sub: done ? `${mdKey(dayKey(at[m.id]))}获得` : `还没获得 · ${leftTxt}` };
  });
}

let recRingMode = 'week';
function viewRecords() {
  const R = records();
  const when = a => `${mdKey(dayKey(a.start))} · ${esc(actName(a))}`;
  if (!R.speed && !R.farthest) {
    root.innerHTML = banners() + head(`${S.name} 的个人最佳`, '纪录') + `<div class="card empty"><b>还没有纪录。</b>遛 ${esc(S.name)} 时在 Tractive 里打开 LIVE，这里会记下最快速度、最长冲刺和最远的一次。</div>`;
    return;
  }
  const recent = Date.now() - 3 * 86400e3;
  // personal records as medals
  const recs = [];
  const add = (o, a) => recs.push({ ...o, isNew: a && a.start >= recent, tileSub: o.tileSub || (a ? mdKey(dayKey(a.start)) : ''), go: o.go !== undefined ? o.go : a ? `#/walk/${a.start}` : null });
  if (R.speed) {
    const v = R.speed.v, jog = v / 2.78, bolt = v / (100 / 9.58), a = R.speed.a;
    add({ id: 'r-speed', title: '最快速度', shape: 'seal', g: PAL.gold, icon: IC.bolt, val: spd(v), unit: spU(),
      sub: `${when(a)}${a.maxAt ? ' · ' + hm(a.maxAt) : ''}`,
      desc: jog >= 1.5 ? `是人慢跑速度的 ${jog.toFixed(1)} 倍，${bolt >= 1 ? '比博尔特百米的平均速度还快' : `相当于博尔特百米平均速度的 ${Math.round(bolt * 100)}%`}。` : '',
      viz: `<div class="gaugebox">${gauge(v)}</div>` }, a);
  }
  if (R.sprint) {
    const { a, sp } = R.sprint, [v, u] = distParts(sp.dist);
    add({ id: 'r-sprint', title: '最长冲刺', shape: 'hex', g: PAL.ruby, icon: IC.run, val: v, unit: u, sub: when(a),
      desc: `一口气跑了 ${durText(sp.dur)}，一直快过 ${Math.round(E.CFG.sprintV * SPK())} ${spU()}，最快 ${spdText(sp.vmax)}。${sp.dist >= 100 ? `差不多 ${(sp.dist / 100).toFixed(1)} 个百米跑道。` : ''}下面是这段冲刺的路线。`, viz: vizSprint(a, sp) }, a);
  }
  if (R.running) {
    const a = R.running.a, [v, u] = distParts(R.running.v);
    add({ id: 'r-run', title: '跑得最多', shape: 'circle', g: PAL.sapphire, icon: IC.paw, val: v, unit: u, sub: when(a),
      desc: `一次运动里 ${(a.sprints || []).length} 段快跑加起来的距离。图上加粗的就是快跑的路段。`, viz: vizRoute(a, a.sprints) }, a);
  }
  if (R.farthest) {
    const a = R.farthest.a, [v, u] = distParts(R.farthest.v);
    add({ id: 'r-far', title: '最远一次', shape: 'oct', g: PAL.emerald, icon: IC.route, val: v, unit: u, sub: when(a),
      desc: `运动时间 ${durText(a.movingTime)}，平均 ${spdText(a.avgMoving)}。`, viz: vizRoute(a, null) }, a);
  }
  if (R.longest) {
    const a = R.longest.a;
    add({ id: 'r-long', title: '最长时间', shape: 'circle', g: PAL.amethyst, icon: IC.clock, val: String(Math.round(R.longest.v / 60)), unit: '分钟', sub: when(a),
      desc: `真正在动的时间 ${durText(R.longest.v)}，加上停下来闻闻看看，一共在外面 ${durText(a.duration)}。`, viz: vizClock(R.longest.v) }, a);
  }
  if (R.mostSprints) {
    const a = R.mostSprints.a;
    add({ id: 'r-many', title: '冲刺最多', shape: 'hex', g: PAL.pink, icon: IC.bolt, val: String(R.mostSprints.v), unit: '次', sub: when(a),
      desc: `一次运动里冲刺了 ${R.mostSprints.v} 次，每个点是一次。`, viz: vizDots(R.mostSprints.v) }, a);
  }
  if (R.bestDay) {
    const d = R.bestDay, [v, u] = distParts(d.dist);
    recs.push({ id: 'r-day', title: '一天最远', shape: 'circle', g: PAL.teal, icon: IC.sun, val: v, unit: u, isNew: dayStart(d.key) >= recent - 86400e3,
      tileSub: mdKey(d.key), sub: `${mdKey(d.key)} ${wdKey(d.key)} · ${d.walks.length} 次运动`, desc: '这一天的三个圆环：距离、活动和散步次数。',
      viz: `<div class="sh-rings">${ringsSVG(fracs(d), 120, 14, 3)}</div>`, go: `#/today/${d.key}`, goLabel: '查看这一天' });
  }
  if (R.streak) recs.push({ id: 'r-streak', title: '连续运动', shape: 'oct', g: PAL.copper, icon: IC.flame, val: String(R.streak), unit: '天',
    tileSub: R.streakNow === R.streak ? '还在继续' : `现在 ${R.streakNow} 天`, sub: R.streakNow === R.streak ? '每天都出门了，还在继续' : R.streakNow ? `现在连续 ${R.streakNow} 天` : '',
    desc: '每天至少出门运动一次。下面是最近四周，填满的是出门的日子。', viz: vizStreak(), go: null });
  const ach = achievements(R), got = ach.filter(m => !m.locked);
  ach.sort((x, y) => (x.locked - y.locked) || (y.prog - x.prog));
  const awards = new Map([...recs, ...ach].map(o => [o.id, o]));

  // rings: the best of the last 7 days (or today) against the three all-time records
  let ringsCard = '';
  const ringsBody = () => {
    const tk = todayKey(), n = recRingMode === 'today' ? 1 : 7;
    const days = []; for (let i = 0; i < n; i++) days.push(dayOf(addDays(tk, -i)));
    const best = (f) => Math.max(0, ...days.map(f));
    const rows = [
      ['var(--k1)', '速度', best(d => d.maxV), R.speed.v, spdText],
      ['var(--k2)', '冲刺', best(d => Math.max(0, ...d.acts.flatMap(a => (a.sprints || []).map(s => s.dist)))), R.sprint ? R.sprint.sp.dist : 0, distText],
      ['var(--k3)', '一天距离', best(d => d.dist), R.bestDay.dist, distText],
    ];
    const fr = rows.map(r => r[3] > 0 ? r[2] / r[3] : 0);
    return `<div class="kr">${ringsSVG(fr, 156, 17, 3, '', ['var(--k1)', 'var(--k2)', 'var(--k3)'])}<span class="kpaw">${IC.paw}</span></div>
      <div class="kleg">${rows.map(([c, l, x, rec, fmt], i) => `<div style="--c:${c}"><div class="kl"><i></i>${l}${fr[i] >= 0.999 ? '<span class="kbadge">纪录</span>' : ''}</div><div class="kv">${x > 0 ? fmt(x) : '—'}</div><div class="ks">纪录 ${fmt(rec)} · ${Math.round(Math.min(fr[i], 9.99) * 100)}%</div></div>`).join('')}</div>`;
  };
  if (R.speed && R.bestDay) {
    ringsCard = `<section class="card kcard"><div class="kh"><h2>离纪录有多远</h2><div class="seg" role="group" aria-label="比较范围">${[['week', '最近 7 天'], ['today', '今天']].map(([k, l]) => `<button type="button" data-rmode="${k}" aria-pressed="${recRingMode === k}">${l}</button>`).join('')}</div></div>
      <div class="kring" id="kring">${ringsBody()}</div>
      <div class="chips"><span>从 ${mdKey(dayKey(R.tot.since))}起</span><span><b>${R.tot.n}</b> 次运动</span><span><b>${distText(R.tot.dist)}</b></span><span><b>${R.tot.sprints}</b> 次冲刺</span></div></section>`;
  }
  // fun facts around the 24-hour dial
  const facts = [];
  const places = new Map();
  D.acts.filter(isWalk).forEach(a => { const p = placeOf(a), w = p ? p.label : nearHome(a) ? '家附近' : null; if (w) places.set(w, (places.get(w) || 0) + 1); });
  const away = [...places].sort((x, y) => y[1] - x[1]).find(([w]) => w !== '家附近');
  if (away && away[1] >= 2) facts.push(['var(--k2)', IC.pin, `最常去 <b>${esc(away[0])}</b>，去了 ${away[1]} 次`]);
  if (R.earliest) facts.push(['#f2a100', IC.sun, `最早 <b>${hm(R.earliest.a.start)}</b> 就出门了（${esc(mdKey(dayKey(R.earliest.a.start)))}）`]);
  if (R.latest && R.latest.a !== R.earliest?.a) facts.push(['#4b52c9', IC.moon, `最晚到 <b>${hm(R.latest.a.end)}</b> 才回家（${esc(mdKey(dayKey(R.latest.a.end)))}）`]);
  const walksAll = D.acts.filter(isWalk);
  const clockCard = walksAll.length ? `<section class="card"><h2>什么时候出门</h2><p class="hint">每一段是一次运动，颜色越深的时段出门越多</p>
      <div class="dialwrap">${dial24(walksAll)}<div class="dialc">${R.slot ? `<small>最常在</small><b>${R.slot[0]}</b><small>${R.slot[1]} / ${R.tot.n} 次</small>` : ''}</div></div>
      ${facts.length ? `<ul class="facts">${facts.map(([c, ic, f]) => `<li style="--c:${c}"><span class="chip">${ic}</span><span>${f}</span></li>`).join('')}</ul>` : ''}</section>` : '';
  root.innerHTML = `<div class="rec-wash" aria-hidden="true"></div>` + banners() + head(`${S.name} 的个人最佳`, '纪录') + ringsCard +
    `<h2 class="sec-title">个人纪录<small>点奖章看详情</small></h2><div class="awards">${recs.map(awardTile).join('')}</div>` +
    `<h2 class="sec-title">成就<small>已获得 ${got.length} / ${ach.length}</small></h2><div class="awards">${ach.map(awardTile).join('')}</div>` + clockCard +
    `<p class="group-foot" style="margin-top:4px">冲刺：至少 ${E.CFG.sprintMin} 秒都快过 ${Math.round(E.CFG.sprintV * SPK())} ${spU()}，速度要定位和项圈测速都认可。速度纪录只算打开 LIVE 的运动。</p>`;
  root.querySelectorAll('[data-rmode]').forEach(b => b.addEventListener('click', () => { recRingMode = b.dataset.rmode; root.querySelectorAll('[data-rmode]').forEach(x => x.setAttribute('aria-pressed', String(x === b))); $('#kring').innerHTML = ringsBody(); }));
  root.querySelectorAll('[data-award]').forEach(b => b.addEventListener('click', () => { const o = awards.get(b.dataset.award); if (o) awardSheet(o); }));
}

// ---------- view: settings ----------
function viewSettings() {
  const tzs = (() => { try { return Intl.supportedValuesOf('timeZone'); } catch { return ['Asia/Shanghai', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'Europe/London', 'UTC']; } })();
  const syncRow = D.synced.length ? `<div class="row file"><div><div class="nm">Tractive 自动同步</div><span class="sub">${D.synced.length} 天 · ${esc(mdKey(D.synced[0].name.slice(-10)))} 至 ${esc(mdKey(D.synced[D.synced.length - 1].name.slice(-10)))}</span></div></div>` : '';
  const fileRows = syncRow + D.files.map(f => `<div class="row file"><div><div class="nm">${esc(f.name)}</div><span class="sub">${esc(mdKey(dayKey(f.first)))} ${hm(f.first)} 至 ${esc(mdKey(dayKey(f.last)))} ${hm(f.last)} · ${f.count} 个点</span></div><button type="button" data-del="${esc(f.id)}">删除</button></div>`).join('');
  const steps = isIOS && !standalone ? `<div class="group notes"><p><b>装到主屏幕</b></p><ol class="steps"><li>用 Safari 打开这个页面</li><li>点底部的分享按钮（方框加向上箭头）</li><li>选「添加到主屏幕」</li></ol></div>` : '';
  root.innerHTML = head('', '设置') + steps +
    `<div class="group-title">狗狗</div><div class="group">
      <div class="row"><label for="sName">名字</label><input id="sName" value="${esc(S.name)}" maxlength="20" autocomplete="off"></div>
      <div class="row"><label for="sWeight">体重（kg）<span class="sub">用来估算消耗的热量</span></label><input id="sWeight" type="number" inputmode="decimal" min="0.5" max="120" step="0.1" value="${esc(S.weight)}" placeholder="未填写"></div>
    </div>
    <div class="group-title">每日目标</div><div class="group">
      <div class="row"><label for="sKm"><i style="display:inline-block;width:10px;height:10px;border-radius:50%;background:var(--r-dist);margin-right:8px"></i>距离（km）</label><input id="sKm" type="number" inputmode="decimal" min="0.1" max="50" step="0.1" value="${esc(S.goalKm)}"></div>
      <div class="row"><label for="sMin"><i style="display:inline-block;width:10px;height:10px;border-radius:50%;background:var(--r-min);margin-right:8px"></i>活动（分钟）<span class="sub">默认跟随 Tractive 的建议</span></label><input id="sMin" type="number" inputmode="numeric" min="5" max="600" step="5" value="${esc(S.goalMin)}"></div>
      <div class="row"><label for="sWalks"><i style="display:inline-block;width:10px;height:10px;border-radius:50%;background:var(--r-walk);margin-right:8px"></i>散步（次）</label><input id="sWalks" type="number" inputmode="numeric" min="1" max="10" step="1" value="${esc(S.goalWalks)}"></div>
    </div>
    <div class="group-title">自动同步</div><div class="group">
      <div class="row"><label for="sRepo">数据仓库</label><input id="sRepo" autocomplete="off" spellcheck="false" autocapitalize="off" value="${esc(S.ghRepo)}" placeholder="用户名/mio-data"></div>
      <div class="row"><label for="sTok">GitHub 令牌</label><input id="sTok" type="password" autocomplete="off" spellcheck="false" placeholder="粘贴 github_pat_ 开头的令牌" value="${esc(S.ghToken)}"></div>
      <div class="row"><span>立即同步<span class="sub">${S.lastSync ? '上次检查 ' + esc(mdKey(dayKey(S.lastSync))) + ' ' + hm(S.lastSync) : '还没有同步过'}</span></span><button class="btn secondary" type="button" data-do="sync">同步</button></div>
    </div>
    <p class="group-foot">GitHub 每小时会自动从 Tractive 拉一次数据，App 打开时自动读取。点「同步」会让它马上拉一次，大约 1 分钟。令牌只保存在这台手机上。</p>
    <div class="group-title">地图</div><div class="group">
      <div class="row"><label for="sMap">地图服务</label><select id="sMap"><option value="esri" ${S.mapProvider !== 'google' ? 'selected' : ''}>免费地图（Esri）</option><option value="google" ${S.mapProvider === 'google' ? 'selected' : ''}>Google 地图</option></select></div>
      <div class="row" id="gkeyRow" ${S.mapProvider === 'google' ? '' : 'hidden'}><label for="sGkey">Google API 密钥</label><input id="sGkey" type="password" autocomplete="off" spellcheck="false" placeholder="粘贴 AIza 开头的密钥" value="${esc(S.gkey)}"></div>
    </div>
    <p class="group-foot">Google 地图需要你自己申请 Maps JavaScript API 密钥，只保存在这台手机上。没填密钥时用免费地图。</p>
    <div class="group-title">运动名称</div><div class="group">
      <div class="row"><label for="sPlace">自动识别地点<span class="sub">比如在狗公园、公园里，名字会带上地点</span></label><select id="sPlace" style="width:auto"><option value="1" ${S.placeLookup ? 'selected' : ''}>开</option><option value="0" ${S.placeLookup ? '' : 'selected'}>关</option></select></div>
    </div>
    <p class="group-foot">识别地点时，会把运动中心的大致位置发给 OpenStreetMap 查询地名，每个地方只查一次；家附近 ${HOME_NEAR} m 内的运动不查。想自己起名，在运动详情页点右上角的笔。</p>
    <div class="group-title">数据</div><div class="group">
      <div class="row"><span>导入 GPX</span><button class="btn secondary" type="button" data-do="import">选择文件</button></div>
      ${fileRows || `<div class="row"><span class="sub" style="font-size:14px">${D.demo ? '现在显示的是示例数据，导入后自动替换' : '还没有导入文件'}</span></div>`}
    </div>
    <div class="group">
      <div class="row"><span>备份全部数据<span class="sub">存到「文件」App 或发给自己</span></span><button class="btn secondary" type="button" data-do="backup" ${D.files.length || D.synced.length ? '' : 'disabled'}>备份</button></div>
      <div class="row"><span>从备份恢复</span><button class="btn secondary" type="button" data-do="restore">选择备份</button></div>
      <div class="row"><button class="btn danger" type="button" data-do="clear" ${D.files.length || D.synced.length ? '' : 'disabled'}>清除全部数据</button></div>
    </div>
    <p class="group-foot">${DB.ok() ? '数据只保存在这台设备上，不会上传。' : '这个浏览器不允许保存数据（可能是无痕模式），关掉页面后数据会丢失。'}</p>
    <div class="group-title">显示</div><div class="group">
      <div class="row"><label for="sUnit">速度单位</label><select id="sUnit" style="width:auto"><option value="kmh" ${S.speedUnit !== 'mph' ? 'selected' : ''}>km/h</option><option value="mph" ${S.speedUnit === 'mph' ? 'selected' : ''}>mph</option></select></div>
      <div class="row"><label for="sTz">时区</label><select id="sTz"><option value="">跟随手机（${esc(sysTz)}）</option>${tzs.map(z => `<option value="${esc(z)}" ${S.tz === z ? 'selected' : ''}>${esc(z)}</option>`).join('')}</select></div>
    </div>
    <div class="group-title">说明</div><div class="group notes">
      <p><b>自动同步（推荐）：</b>GitHub 上的私有仓库 mio-data 每小时自动从 Tractive 拉取数据，填好上面的仓库和令牌后，打开 App 就是最新的。</p>
      <p><b>手动导入 GPX：</b>用 Safari 打开 Tractive 网页版，在历史轨迹里选好日期导出 GPX，文件会存到「文件」App 的下载里，再回这里点右上角的 + 导入。可以一次选多个文件，重复导入同一天也没关系。</p>
      <p><b>三个圆环：</b>外圈是距离，中圈是活动分钟，内圈是散步次数。活动分钟优先用 Tractive 项圈传感器的数据（在家玩、院子里跑也算），没有时用 GPS 检测到移动的时间。</p>
      <p><b>采样决定细节：</b>Tractive 平时约 10 分钟定位一次，只有 LIVE 模式下才 2 到 4 秒记录一次。距离、速度、分段主要来自 LIVE 记录，所以遛狗时记得打开 LIVE。</p>
      <p><b>漂移过滤：</b>静止时 GPS 也会在几十米内跳动，这些漂移不计入距离。持续超过 ${Math.round(E.CFG.vehicleV * SPK())} ${spU()} 的路段视为乘车，会从活动里整段去掉，活动只从下车后开始算。</p>
      <p style="margin:0"><b>消耗</b>按 Taylor 等人（1982）的犬类运动能耗公式估算；<b>海拔</b>来自 GPS，误差 10 到 30 m，仅供参考。</p>
    </div>`;
  const num = (id, key, min, max) => $('#' + id).addEventListener('change', e => { const v = parseFloat(e.target.value); if (v >= min && v <= max) { S[key] = v; saveSettings(); } else e.target.value = S[key]; });
  $('#sName').addEventListener('change', e => { S.name = e.target.value.trim() || 'Mio'; saveSettings(); });
  $('#sWeight').addEventListener('change', e => { const v = parseFloat(e.target.value); S.weight = v > 0 && v <= 120 ? v : ''; e.target.value = S.weight; saveSettings(); });
  num('sKm', 'goalKm', 0.1, 50); num('sMin', 'goalMin', 5, 600); num('sWalks', 'goalWalks', 1, 10);
  $('#sMin').addEventListener('change', () => { S.goalMinCustom = true; saveSettings(); });
  $('#sMap').addEventListener('change', e => { S.mapProvider = e.target.value; saveSettings(); $('#gkeyRow').hidden = S.mapProvider !== 'google'; if (S.mapProvider === 'google' && !S.gkey) $('#sGkey').focus(); });
  $('#sGkey').addEventListener('change', e => { S.gkey = e.target.value.trim(); saveSettings(); gmPromise = null; });
  $('#sPlace').addEventListener('change', e => { S.placeLookup = e.target.value === '1'; saveSettings(); resolvePlaces(); });
  $('#sRepo').addEventListener('change', e => { S.ghRepo = e.target.value.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\/$/, ''); e.target.value = S.ghRepo; saveSettings(); try { localStorage.removeItem(KEY_SHA); } catch { /* ignore */ } });
  $('#sTok').addEventListener('change', e => { S.ghToken = e.target.value.trim(); saveSettings(); if (syncReady()) pullSync({ quiet: false }); });
  $('#sUnit').addEventListener('change', e => { S.speedUnit = e.target.value === 'mph' ? 'mph' : 'kmh'; saveSettings(); });
  $('#sTz').addEventListener('change', e => { S.tz = e.target.value; saveSettings(); resetTz(); computeDays(); });
  root.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async () => {
    const f = D.files.find(x => x.id === b.dataset.del); if (!f) return;
    if (!await confirmBox(`删除「${f.name}」？这个文件里的轨迹会从记录中移除。`)) return;
    await DB.del(f.id); await loadData(); render(); toast('已删除');
  }));
}

// ---------- in-page confirm (no native dialogs) ----------
function confirmBox(msg) {
  return new Promise(res => {
    const d = document.createElement('dialog');
    d.style.cssText = 'border:0;border-radius:16px;padding:20px;background:var(--surface);color:var(--ink);max-width:320px;width:calc(100vw - 48px)';
    d.innerHTML = `<p style="margin:0 0 16px;font-size:15px">${esc(msg)}</p><div style="display:flex;gap:8px;justify-content:flex-end"><button class="btn secondary" value="no">取消</button><button class="btn" value="yes" style="background:#d03b3b;color:#fff">删除</button></div>`;
    document.body.appendChild(d);
    d.addEventListener('click', e => { const b = e.target.closest('button'); if (b) { d.close(); d.remove(); res(b.value === 'yes'); } });
    d.addEventListener('cancel', () => { d.remove(); res(false); });
    d.showModal();
  });
}

// ---------- import / backup ----------
const fileIn = $('#fileIn'), restoreIn = $('#restoreIn');
fileIn.addEventListener('change', e => { importFiles([...e.target.files]); e.target.value = ''; });
restoreIn.addEventListener('change', e => { if (e.target.files[0]) restore(e.target.files[0]); e.target.value = ''; });
async function importFiles(files) {
  if (!files.length) return;
  toast('正在读取…', 60000);
  let added = 0, pts = 0, lastT = 0; const bad = [];
  for (const f of files) {
    try {
      const text = await f.text();
      if (/^\s*\{/.test(text)) { await restore(f, text); return; }
      const g = E.parseGPX(text);
      if (!g.points.length) { bad.push(f.name); continue; }
      const c = E.clean(g.points);
      await DB.put({ id: `${f.name}@${c[0].t}`, name: f.name, added: Date.now(), count: c.length, creator: g.creator, first: c[0].t, last: c[c.length - 1].t, pts: pack(c) });
      added++; pts += c.length; lastT = Math.max(lastT, c[c.length - 1].t);
    } catch (err) { bad.push(f.name); }
  }
  if (!added) { toast(bad.length ? `没有在 ${bad.join('、')} 里找到带时间的轨迹点，请确认是 GPX 文件` : '没有可导入的文件'); return; }
  try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch { /* optional */ }
  await loadData();
  const key = dayKey(lastT), target = '#/today/' + key;
  toast(`已导入 ${added} 个文件，${pts} 个定位点${bad.length ? `（${bad.length} 个文件读不出来）` : ''}`);
  if (location.hash === target) render(); else location.hash = target;
}
async function backup() {
  const recs = await DB.all();
  const { gkey, ghToken, ...rest } = S;
  const json = JSON.stringify({ app: 'mio-activity', v: 1, exported: Date.now(), settings: rest, files: recs });
  const name = `${S.name}-运动备份-${todayKey()}.json`;
  const blob = new Blob([json], { type: 'application/json' });
  try {
    const file = new File([blob], name, { type: 'application/json' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: name }); return; }
  } catch (e) { if (e && e.name === 'AbortError') return; }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}
async function restore(file, text) {
  try {
    const j = JSON.parse(text || await file.text());
    if (j.app !== 'mio-activity' || !Array.isArray(j.files)) throw new Error('不是这个 App 的备份文件');
    let n = 0;
    for (const r of j.files) {
      if (r && r.id && Array.isArray(r.pts)) { await DB.put(r); n++; }
      else if (r && r.id && (r.kind === 'name' || r.kind === 'health')) await DB.put(r);
    }
    if (j.settings && typeof j.settings === 'object') { const keep = S.gkey, tok = S.ghToken; S = { ...DEFAULTS, ...S, ...j.settings, gkey: keep, ghToken: tok }; saveSettings(); resetTz(); }
    await loadData(); render(); toast(`已恢复 ${n} 个文件`);
  } catch (e) { toast('恢复失败：' + e.message); }
}

// ---------- global clicks ----------
document.addEventListener('click', async e => {
  const go = e.target.closest('[data-go]'); if (go && !go.disabled) { location.hash = go.dataset.go; return; }
  const back = e.target.closest('[data-back]'); if (back) { if (navCount > 0) history.back(); else location.hash = back.dataset.back; return; }
  const b = e.target.closest('[data-do]'); if (!b) return;
  const act = b.dataset.do;
  if (act === 'import') fileIn.click();
  else if (act === 'restore') restoreIn.click();
  else if (act === 'backup') backup();
  else if (act === 'sync') syncNow();
  else if (act === 'hideA2HS') { S.hideA2HS = true; saveSettings(); render(); }
  else if (act === 'clear') { if (await confirmBox('清除这台设备上的全部导入数据？建议先备份。')) { await DB.clear(); try { localStorage.removeItem(KEY_SHA); } catch { /* ignore */ } await loadData(); render(); toast('已清除，现在显示示例数据'); } }
});

// ---------- toast & tip ----------
let toastT;
function toast(msg, ms = 4000) { const t = $('#toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), ms); }
function hideTip() { const t = $('#tip'); if (t) t.classList.remove('on'); }

// ---------- resize ----------
let rsT, lastW = innerWidth;
addEventListener('resize', () => { clearTimeout(rsT); rsT = setTimeout(() => { if (Math.abs(innerWidth - lastW) > 8) { lastW = innerWidth; render(); } }, 200); });

// ---------- demo data (marked as an example in the UI) ----------
function demoPoints() {
  let seed = 11;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const gauss = () => { let u = 0; for (let i = 0; i < 6; i++) u += rnd(); return u - 3; };
  const lat0 = 40.7790, lon0 = -73.9555, ky = 111320, kx = ky * Math.cos(lat0 * Math.PI / 180);
  const now = Date.now(), pts = [];
  const add = (t, x, y, e, spd) => { if (t <= now) pts.push({ t, lat: lat0 + y / ky, lon: lon0 + x / kx, ele: e, spd }); };
  const ping = t => add(t, gauss() * 14, gauss() * 14, Math.round(30 + gauss() * 8), +(Math.abs(gauss()) * 0.3).toFixed(1));
  const ang = 29 * Math.PI / 180, ux = [Math.sin(ang), Math.cos(ang)], cx = [Math.cos(ang), -Math.sin(ang)];
  const C = [(-73.9626 - lon0) * kx, (40.7851 - lat0) * ky];
  const ell = th => [C[0] + 410 * Math.cos(th) * ux[0] + 260 * Math.sin(th) * cx[0], C[1] + 410 * Math.cos(th) * ux[1] + 260 * Math.sin(th) * cx[1]];
  const entry = ell(Math.PI / 2), corner = [entry[0] + 160, entry[1] - 260];
  const loop = [[0, 0], [corner[0] * 0.4, corner[1] * 0.3 + 120], corner, entry];
  for (let k = 1; k <= 72; k++) loop.push(ell(Math.PI / 2 - k / 72 * 2 * Math.PI));
  loop.push(corner, [0, 0]);
  const block = [[0, 0], [70, 40], [-60, 270], [-130, 230], [0, 0]], block2 = block.concat(block.slice(1));
  const walk = (tStart, path, base) => {
    const segL = []; let L = 0;
    for (let i = 1; i < path.length; i++) { const l = Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]); segL.push(l); L += l; }
    const at = d => { let i = 0; while (i < segL.length - 1 && d > segL[i]) { d -= segL[i]; i++; } const f = Math.min(1, d / segL[i]); return [path[i][0] + (path[i + 1][0] - path[i][0]) * f, path[i][1] + (path[i + 1][1] - path[i][1]) * f]; };
    const trotAt = rnd() * 0.7 + 0.1, sprint = rnd() < 0.4 ? rnd() * 0.8 + 0.1 : -1;
    let d = 0, t = tStart, ele = 32, pause = 0, mult = 1;
    while (d < L) {
      let v = d / L > trotAt && d / L < trotAt + 0.03 ? 2.6 : sprint > 0 && d / L > sprint && d / L < sprint + 0.006 ? 4.6 : base;
      if (pause > 0) { v = 0; pause -= 3; } else if (rnd() < 0.012) pause = 12 + Math.floor(rnd() * 40);
      mult += (0.8 + rnd() * 0.4 - mult) * 0.15; v = Math.max(0, v * mult);
      const dt = rnd() < 0.08 ? 6 : 3; d += v * dt;
      const [x, y] = at(Math.min(d, L));
      ele += gauss() * 1.2; ele += (32 - ele) * 0.1;
      add(t, x + gauss() * 1.1, y + gauss() * 1.1, Math.round(ele), +(v + gauss() * 0.2).toFixed(1));
      t += dt * 1000;
    }
    return t;
  };
  const tk = todayKey();
  for (let k = 20; k >= 0; k--) {
    const key = addDays(tk, -k), d0 = dayStart(key);
    const ws = [];
    if (rnd() > 0.08) {
      ws.push([d0 + (7 + rnd() * 1.2) * 3600e3, rnd() < 0.6 ? loop : block2, 1.25 + rnd() * 0.2]);
      if (rnd() < 0.75) ws.push([d0 + (17.5 + rnd() * 1.5) * 3600e3, rnd() < 0.5 ? block : block2, 1.1 + rnd() * 0.2]);
      if (rnd() < 0.15) ws.push([d0 + (12.5 + rnd()) * 3600e3, block, 1.2]);
    }
    ws.sort((a, b) => a[0] - b[0]);
    let t = d0 + 6 * 3600e3 + rnd() * 600e3;
    for (const w of ws) { while (t < w[0] - 120e3) { ping(t); t += 540e3 + rnd() * 120e3; } t = walk(w[0], w[1], w[2]) + 240e3; }
    while (t < d0 + 23 * 3600e3) { ping(t); t += 540e3 + rnd() * 120e3; }
  }
  return pts;
}

// ---------- boot ----------
(async () => {
  try { localStorage.removeItem('mio.unlock.v1'); } catch { /* leftover from the removed password page */ }
  root.innerHTML = '<div class="loading">正在载入…</div>';
  const st = await DB.open();
  if (st === 'timeout') { root.innerHTML = '<div class="card empty" style="margin-top:40px"><b>数据读取卡住了。</b>这是 iPhone 上偶尔会遇到的系统问题：请从后台彻底划掉这个 App，再重新打开。数据不会丢。</div>'; return; }
  try { await loadData(); } catch (e) { root.innerHTML = `<div class="card empty">数据读取失败：${esc(e.message)}</div>`; return; }
  render();
  pullSync();
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && Date.now() - (S.lastSync || 0) > 5 * 60e3) pullSync(); });
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
})();
})();
