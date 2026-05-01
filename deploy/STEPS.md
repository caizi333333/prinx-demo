# 一次性部署 PRINX HMI Demo 到 sunyancai.top/prinx/

## 已完成（自动）
- ✅ GitHub 仓库已建：[caizi333333/prinx-demo](https://github.com/caizi333333/prinx-demo)
- ✅ mockup 完整代码已 push 到 main 分支
- ✅ CF Worker 路由脚本已准备 ([cf-worker.js](cf-worker.js))

## 你需要做的 3 步

### Step 1 · 在 CF Pages 接入 GitHub 仓库（约 2 分钟）

1. 打开 https://dash.cloudflare.com/?to=/:account/pages
2. 点击 **Create a project** → **Connect to Git** → 授权 GitHub → 选 **prinx-demo** 仓库
3. 配置：
   - **Project name**：`prinx-demo`
   - **Production branch**：`main`
   - **Framework preset**：`None`
   - **Build command**：（留空）
   - **Build output directory**：`/`
4. **Save and Deploy**
5. 部署完成后访问 `https://prinx-demo.pages.dev` 应能看到登录页（任意密码可登入）

### Step 2 · 加 Worker 路由把 /prinx/* 转发过去（约 3 分钟）

1. 打开 https://dash.cloudflare.com/?to=/:account/workers/services
2. **Create application** → **Create Worker** → 命名 `prinx-route` → **Deploy**
3. 进入新建的 worker → **Edit code** → 把 [cf-worker.js](cf-worker.js) 粘贴进去 → **Save and Deploy**
4. 该 worker 详情页 → **Triggers** → **Add Route**：
   - **Route**：`sunyancai.top/prinx/*`
   - **Zone**：sunyancai.top
   - **Save**
5. 等 30 秒 DNS 生效，访问 `https://sunyancai.top/prinx/login.html` 应可见登录页

### Step 3 · （可选）加根目录跳转

`https://sunyancai.top/prinx` 默认会落到 login.html（仓库根的 `index.html` 已配置 meta refresh）。如果你希望 `https://sunyancai.top/prinx/` 直接重定向到 design.html（设计稿首页）作品集风格，编辑 mockup/index.html 改 `url=design.html` 即可。

## 验证清单

| URL | 期望 |
|---|---|
| `prinx-demo.pages.dev/login.html` | CF 直连，登录表单 |
| `sunyancai.top/prinx/login.html` | 经 Worker 转发，登录表单 |
| `sunyancai.top/prinx/pages/overview.html` | 4 挤出机数值 1Hz 浮动，watermark "DEMO MODE" |
| `sunyancai.top/prinx/pages/control.html` | 每 12s 出 cycle，每 90s PINN flip |

## 后续更新

每次改了 `mockup/` 里任意文件：

```bash
cd /Users/alex/Drsun/平台软件开发/mockup
git add -A && git commit -m "update demo" && git push
# CF Pages 自动构建 + 部署，约 30s 后生效
```

Worker 脚本几乎不需要改，除非换主域。
