# PRINX HMI Demo · Cloudflare Pages 部署

把 `mockup/` 静态目录部署到 Cloudflare Pages，让 **sunyancai.top/prinx/** 直接展示完整 v0.5 UI。所有数据由浏览器内 [demo-mock.js](demo-mock.js) 提供（拦截 `fetch` 与 `WebSocket`）—— 无需任何后端。

## 工作原理

| 层 | 实现 |
|---|---|
| 静态文件 | `mockup/*.html` + `style.css` + `live.js` + `demo-mock.js` |
| 模拟数据 | `demo-mock.js` 浏览器内 1 Hz simulator（演化 82 个信号） |
| 假后端 API | `fetch('/api/...')` 拦截，返回种子配方/工单/告警/cycle |
| 假 WebSocket | `WebSocket` 构造拦截 → `FakeWebSocket` 派发 signal_delta / cycle_complete / pinn_status_change |
| 自动启用 | `demo-mock.js` 检查 `location.hostname` 是否在 `sunyancai.top` / `*.pages.dev` / `localhost` 列表 |

每个 HTML 都形如：

```html
<script src="../demo-mock.js"></script>
<script src="../live.js"></script>
```

`demo-mock` 必须在 `live.js` 之前加载，确保 `fetch` / `WebSocket` 在 live.js 调用前已被替换。

## 部署方式 — 两选一

### 方式 A · 在 sunyancai.top 主仓库里加子目录（最简）

如果 sunyancai.top 由 CF Pages + 一个 git 仓库部署：

```bash
# 1. 把 mockup/ 复制到主仓库的 public/prinx/（或 dist/prinx/，取决你的框架）
cd <你的-sunyancai-repo>
cp -r /Users/alex/Drsun/平台软件开发/mockup public/prinx

# 2. 提交并推送
git add public/prinx
git commit -m "Add PRINX HMI v0.5 demo at /prinx/"
git push

# 3. CF Pages 自动构建部署，访问 https://sunyancai.top/prinx/
```

如果你的主站是 Hugo / Astro / Next 等会编译输出的框架：把 `mockup/` 放在框架的「不处理」目录（Hugo 的 `static/`，Astro 的 `public/`，Next 的 `public/`），路径会原样输出。

**优点**：单仓库、单部署、零额外配置。
**缺点**：和主站绑定，主站重新构建时会一起部署。

### 方式 B · 独立 Pages 项目 + Worker route（更干净）

```bash
# 1. 建独立仓库
cd /Users/alex/Drsun/平台软件开发
git init -C mockup
cd mockup
git add . && git commit -m "PRINX HMI v0.5 demo"
gh repo create prinx-demo --public --push --source=.

# 2. CF Dashboard → Pages → Create project → Connect to Git → 选 prinx-demo 仓库
#    Build settings:
#      Framework preset: None
#      Build command:    (留空)
#      Build output directory: /
#    第一次部署后获得 prinx-demo.pages.dev

# 3. 主域 sunyancai.top → Workers Routes 加规则把 /prinx/* 转到 prinx-demo
#    或者：Pages 项目 → Custom Domains → 加 sunyancai.top/prinx/* 路由
```

或者用 CF Worker（脚本如下）路由：

```js
// cloud worker: prinx-route.js
export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/prinx/')) {
      return fetch(request);  // 保留主站
    }
    const sub = url.pathname.slice('/prinx'.length) || '/';
    const dest = new URL(sub + url.search, 'https://prinx-demo.pages.dev');
    return fetch(new Request(dest, request));
  },
};
```

绑定到 sunyancai.top 的 `/prinx/*` route。

**优点**：解耦，主站节奏与 demo 独立。
**缺点**：多一个项目维护。

## 子路径处理（如果选方式 A）

`mockup/` 内所有相对引用（`../live.js`、`<a href="alarm.html">`）都基于 HTML 文件位置，不会受 `/prinx/` 前缀影响。**唯一注意**：`mockup/_redirects` 里把 `/` → `/login.html` 的规则，如果方式 A 时主站根路径已被占用，需要把这个文件挪到 `mockup/login.html` 自己的逻辑（已自带 token 检查 + 跳转），或者删掉 `_redirects`。

CF Pages 子目录部署时通常不需要 `_redirects`：访问 `sunyancai.top/prinx/` 默认会找 `prinx/index.html`，没有就 404；建议在 `prinx/` 根放 `index.html` 简单跳到 `login.html`：

```bash
echo '<meta http-equiv="refresh" content="0; url=login.html">' > mockup/index.html
```

mockup 目录里已经有 `index.html`（设计稿首页），直接保留亦可（用户看到设计稿后从顶栏进入子页）。

## 验证清单

部署后访问以下页面应都正常：

| URL | 期望 |
|---|---|
| `sunyancai.top/prinx/login.html` | 登录表单。任意账号密码都成功 |
| `sunyancai.top/prinx/pages/overview.html` | 4 挤出机数值 1Hz 浮动；卷取长度增长；watermark "DEMO MODE" |
| `sunyancai.top/prinx/pages/control.html` | 每 12s 出 cycle，每 90s PINN 状态翻转触发顶部红/正常切换 |
| `sunyancai.top/prinx/pages/alarm.html` | 2 条种子告警，约 25s 触发新告警 |
| `sunyancai.top/prinx/pages/recipe.html` | 2 条配方，可点击克隆/审批/下载 |
| `sunyancai.top/prinx/pages/training.html` | 3 条历史 job、2 个 in_use 模型、1 个 shadow 模型 |

打开浏览器 DevTools console 应看到：

```
[PRINX demo] mock layer installed — fetch + WebSocket intercepted
```

如果看到 `[PRINX demo] non-demo host xxx — mock layer not installed`，说明 hostname 不在白名单。检查 [demo-mock.js:8](demo-mock.js) 里的 `knownDemoHost` 列表，按需加你的域名。

## 真 backend 联调时

未来如果你架了 VPS 跑真后端：

1. URL 加 `?demo=0` 强制关 demo（一次性）。
2. 把 demo-mock 的 hostname 列表移除你的域名（永久）。
3. 改 `live.js` 的 `wsUrl()` 与 `apiFetch` 用绝对地址指向 `https://prinx-api.sunyancai.top`，并打开 backend 的 CORS allow `https://sunyancai.top`。

## 文件清单

```
mockup/
├── index.html          # 项目主页（设计稿）
├── login.html          # JWT 登录页（demo 下任何密码都过）
├── live.js             # WS + REST 客户端 + 用户态
├── demo-mock.js        # 浏览器内 simulator + fetch/WS 拦截器
├── style.css           # 全局样式
├── _redirects          # CF Pages 路由（/  → /login.html）
├── _headers            # 安全头 + 缓存策略
└── pages/
    ├── overview.html   # 主画面（实时信号绑定）
    ├── control.html    # 闭环控制 v0.5（cycle 流 / mode / Gate 7）
    ├── alarm.html      # 报警管理 + ack
    ├── recipe.html     # 配方管理（clone/approve/apply）
    ├── training.html   # PINN 训练 + shadow 部署
    ├── trend.html / temperature.html / process.html / mes.html / maintenance.html / report.html
```
