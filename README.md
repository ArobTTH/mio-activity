# Mio 运动

把 Tractive 导出的 GPX 变成每天的活动圆环、散步记录和趋势。装在 iPhone 主屏幕上，像普通 App 一样全屏打开；数据只存在手机里，不会上传，断网也能打开。

## 一次性部署（让手机能装上）

iPhone 只能从 https 网址安装网页 App，所以这个文件夹需要放到一个静态网站上。文件夹里只有程序，没有任何轨迹数据，公开也不会泄露位置。

**GitHub Pages（推荐，免费）**

```bash
cd app
git init && git add . && git commit -m "Mio 运动"
gh repo create mio-activity --public --source . --push
gh api -X POST repos/{owner}/mio-activity/pages -f "source[branch]=main" -f "source[path]=/"
```

一两分钟后网址是 `https://<你的 GitHub 用户名>.github.io/mio-activity/`。

**不想用 GitHub：** 打开 app.netlify.com/drop，把整个 `app` 文件夹拖进去，也能拿到一个网址。

## 装到 iPhone

1. 用 **Safari** 打开上面的网址
2. 点底部的分享按钮（方框加向上箭头）
3. 选「添加到主屏幕」

## 自动同步（推荐）

私有仓库  里的 GitHub Actions 每小时登录 Tractive 拉一次数据。设置一次以后，打开 App 就是最新的，不用再导出导入：

1. 在 mio-data 仓库的 Settings → Secrets and variables → Actions 里添加  和 2. 在 github.com/settings/personal-access-tokens/new 新建 Fine-grained token：只选 mio-data 仓库，Contents 只读，Actions 读写
3. 把令牌粘贴到 App 的「设置 → 自动同步」

详细说明见 mio-data 仓库的 README。

## 手动导入（不用自动同步时）

1. 遛狗时在 Tractive 里打开 **LIVE**（2 到 4 秒记录一次；不开的话约 10 分钟才一个点，算不出速度和分段）
2. 用 Safari 打开 Tractive 网页版，在历史轨迹里导出当天的 GPX，文件会存到「文件」App
3. 打开 Mio 运动，点右上角 **+**，选「选取文件」，选中 GPX（可以多选，重复导入同一天没关系）

导入的数据保存在手机里。换手机或清理前，在「设置 → 备份全部数据」存一份。

## 三个圆环

| 圆环 | 含义 | 默认目标 |
|---|---|---|
| 外圈 | 距离（已滤除静止时的 GPS 漂移） | 2 km |
| 中圈 | 运动分钟（检测到在移动的时间） | 60 分钟 |
| 内圈 | 散步次数 | 2 次 |

目标在「设置」里改。

## 用 Google 地图（可选）

默认用免费的 Esri 地图。想换成 Google 地图：

1. 打开 console.cloud.google.com，新建一个项目
2. 按提示开通结算（要绑定信用卡；个人使用量在每月免费额度内，正常不会扣费）
3. 「API 和服务 → 库」里启用 **Maps JavaScript API**
4. 「API 和服务 → 凭据 → 创建凭据 → API 密钥」
5. 编辑这个密钥：「应用限制」选「网站」，填 `https://<你的 GitHub 用户名>.github.io/*`；「API 限制」只勾 Maps JavaScript API
6. 复制密钥，打开 App 的「设置 → 地图服务」选 Google 地图，粘贴密钥

密钥只保存在手机上，备份文件里也不会包含。

## 更新 App

改完代码后，把 `sw.js` 第一行的 `VERSION` 改个数字（比如 `mio-v2`），再推送到 GitHub。手机上打开两次 App 就会换成新版本。

## 文件

- `index.html` / `app.css` / `app.js`：界面
- `engine.js`：分析算法（漂移过滤、步态、分段、乘车识别），和电脑版 `mio-activity.html` 用的是同一套
- `sw.js`：离线缓存（程序文件，以及看过的地图）
- `leaflet.js` / `leaflet.css`：地图组件 Leaflet 1.9.4
