# AGENTS.md

本仓库用于 DeepSeek Harness (DSH) 插件相关开发。

## 依赖包名规范（重要）

**DeepSeek Harness 的官方 npm 包是 `@deepseek-ai/dsh`，必须只认这个 scope。**

| 名称 | 状态 | 说明 |
| --- | --- | --- |
| `@deepseek-ai/dsh` | ✅ 唯一正确的官方包 | 维护者含 `tianyi@deepseek.com`，bin 名为 `dsh` |
| `deepseek-harness` | ❌ 禁止使用 | 第三方抢注的占位包，`0.0.1` 版，解压仅 581 字节，作者与 DeepSeek 无关 |
| `deepseekHarness` / `deepseek_harness` / `@deepseek/harness` | ❌ 不存在 | 查询返回 404 |

安装、升级、脚本里引用、以及向用户建议命令时，一律使用 `@deepseek-ai/dsh`。不带 scope 的 `deepseek-harness` 在任何场景下都不要安装。

另外，搜索引擎里出现的 `deepseek-harness-plugin.com` 之类站点是第三方内容站，不是官方渠道；官方信息以 `deepseek.com/harness` 与 GitHub `deepseek-ai/deepseek-harness` 仓库为准。

## 本机环境

- 全局安装：`@deepseek-ai/dsh`，位于 `C:\Users\Administrator\AppData\Roaming\npm`（系统 Node v24.14.0 / npm 11.12.0）
- 不要用 WorkBuddy 内置 Node（`.workbuddy\binaries\node\versions\<ver>`）作为 npm prefix 安装全局包：该目录会随 WorkBuddy 升级被替换，装在这里的包会丢失
- npm registry：`https://registry.npmmirror.com`
- DSH 配置目录：`~/.dsh`（`profiles/`、`storages/`、`.credentials.yaml` 等，首次运行自动生成）

## 常用命令

```bash
dsh --version                              # 当前版本
dsh web                                    # 启动 Web UI，默认 http://127.0.0.1:3080
dsh web --no-open --port 8080              # 指定端口且不自动开浏览器
dsh plugin --profile <name> <pnpm-args...> # 安装/管理插件
dsh --profile <name> --dump-config         # 打印组合后的 profile 配置树
```

`dsh web` 启动后会打印带 `?token=` 的访问地址，裸地址会被拒绝访问。

## 版本状态提示

当前为 `0.2.1-rc.5` 开发者预览版，官方明确会有兼容性破坏变更。改动插件代码时不要假设 API 稳定，涉及 profile / 插件接口的变更请先查 `dsh --help` 与 `dsh --profile <name> --help` 的实际输出，不要凭记忆写。

## 本仓库结构

```
package.json                     # 工作区根：@qoder-ai/qoder-agent-sdk 装在这里，供 packages/* 解析
packages/dsh-plugin-qoder/       # Qoder 面板插件（在用的那个）
packages/dsh-plugin-hello/       # 最小验证插件，仅作参考，已从 profile 移除
.poc-sdk/                        # SDK 验证脚本与端到端测试脚本（可删）
```

插件依赖解析规则：`packages/dsh-plugin-qoder/lib/*.js` 的 `import` 会向上找到仓库根的 `node_modules`，所以 SDK 必须装在仓库根，不要装进 `~/.dsh/profiles/<name>/node_modules`。

## dsh 插件机制（已实证）

一个插件包同时是 **bundle** 和 **plugin**，四件套缺一不可：

```
package.json      # dsh.bundle.patch 指向 cordis.patch.yml；dsh.client.platform = "web"
cordis.patch.yml  # - insert: [{ id, name }]
lib/index.js      # 宿主端 ESM：export { name, inject, apply }
lib/client.js     # 客户端：window.__ModuleLoader__.load({ id, factory })
```

四个坑：

1. 只声明 `dsh.client` 不声明 `dsh.bundle` —— 只会被当普通依赖装进去，不会成为 profile layer。
2. patch 新增条目必须包在 `- insert:` 下，否则报 `patch: id is required for non-insert patches`。
3. `dsh plugin --profile web add link:<abs>` 只装依赖并自动登记 bundles；若没登记，手动加进 `~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles`（放最后）。
4. 改动 `lib/*.js` 后必须重启 `dsh web` 才生效，插件不做热重载。

宿主端可用的关键 API：

- HTTP 端点：`ctx.connection.fetch.register({ path, methods, requestBody: 'buffered', fetch: (Request) => Promise<Response> })`，需 `inject = ['connection']`。框架自动处理认证：未登录 401，非 owner 403。
- 路由响应**支持流式**：返回带 `ReadableStream` 的 `Response` 能真正 SSE，框架按 chunk 写出并处理背压。
- 其他 service：`ctx.fs`、`ctx.subprocess`、`ctx.tools`、`ctx.logger`、`ctx.effect`。

客户端 API：

- 挂载：`ctx.slots.register({ name, key }, Component)`；`ctx.effect(fn)` 会**立即执行** fn 并接管其返回值作为 disposer。
- 右侧面板三段式：`ctx.sidebarRightTabs.register({ id, kind, title })` → `ctx.slots.register({ name: 'sidebar.right.pane.tab', key: id }, Body)` → `ctx.sidebarRight.openTab(kind)`。
- `react`、`react/jsx-runtime` 在共享基线模块表里，`require('react')` 直接可用，**不用打包 React**。
- 调宿主直接 `fetch('/api/xxx')`，Cookie 自动携带；SSE 用 `EventSource`。

## Qoder 面板插件（packages/dsh-plugin-qoder）

把 Qoder Agent SDK 包成 dsh 右侧边栏的一个标签页，额度走本机 `qodercli` 登录态。

文件职责：

| 文件 | 作用 |
| --- | --- |
| `lib/index.js` | 注册 9 个 `/api/qoder.*` 路由 |
| `lib/qoder-manager.js` | 会话生命周期、事件日志、SSE、审批、中断 |
| `lib/git-tools.js` | 脏工作区检查、`HEAD` diff（含未跟踪文件） |
| `lib/summary.js` | 滚动摘要落盘到 `.dsh/qoder/summaries/<sessionId>.md` |
| `lib/client.js` | 面板 UI（对话 / 改动 / 摘要 三个视图） |

SDK 侧必须记住的三条：

1. **`permissionMode: 'dontAsk'` 在 daemon query 下不被支持**，会抛 `not supported for daemon Queries`。合法值只有 `default` / `acceptEdits` / `auto` / `bypassPermissions`。
2. `canUseTool` 只对**写类**工具触发，`Read`/`Glob`/只读 Bash 直接放行。所以审批弹窗不会频繁打扰。
3. `options.resume = <session_id>` 可以续接会话；daemon 是进程级共享的，第二次 query 明显快于首次（实测约 3.4 倍）。

产物路径固定为 `.dsh/qoder/`，**不要写 `.qoder/`**：qodercli 对 `.qoder/` 有内置敏感路径保护，agent 写不进去。

### 客户端 half 的 inject 必须写全

cordis 的 Context 是严格模式：**访问未在 `exports.inject` 里声明的服务会直接抛异常，而不是返回 `undefined`**。

这个异常的杀伤力在于它会被 boot 吞掉——页面上只留下 `Failed to load plugins` / `web boot: 1 entry did not activate` / `<包名>: failed`，浏览器控制台里也没有堆栈，只有一句 `apply() called` 之后再无输出。

所以 `exports.inject` 要按实际用到的服务逐个列全：

```js
// 用到 ctx.effect + ctx.slots + 右侧栏两个服务
exports.inject = ['slots', 'sidebarRightTabs', 'sidebarRight'];
```

排查口诀：**`apply()` 里最后一个成功打印的 `console.log` 与失败的语句之间，就是没 inject 的服务**。本次就是 `ctx.slots` 没声明，导致 `slots.register` 那行抛错。

同时 `package.json` 的 `dsh.client.inject` 要声明**包名级**依赖，保证 boot 图顺序：

```json
"dsh": { "client": { "platform": "web", "inject": ["@deepseek-ai/dsh-client-ui-sidebar-right"] } }
```

浏览器侧复现工具在 `.poc-sdk/`：`cdp-console.mjs` 用无头 Chrome 抓控制台与页面正文，`replay-client.mjs` 用假 ctx 回放 bundle 的 `apply`。


