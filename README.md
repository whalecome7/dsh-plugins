# dsh-plugins

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（下称 dsh）写的插件集合。目前主力是 **Qoder 面板**：把 Qoder 的订阅额度接进 dsh 的界面里用。

## 为什么做这个

qodercli 能干活，但它是一个封闭的终端工具：插件无法自定义，改动结果也没有 diff 可看，只能翻终端里滚过去的文本。而 dsh 有可插拔的插件体系和 Web UI。

于是把两边的长处拼起来——**Qoder 当脑，dsh 当壳**：

- 对话真正跑在 Qoder 上，消耗的是你本机的 qoder 订阅积分，不走 dsh 的模型
- 界面、插件、diff 复盘这些提效能力由 dsh 提供

## 能力

**对话** — 在右侧边栏直接和 Qoder 交互，SSE 真流式输出，不是等结束才一次性刷出来。可切换 15 个模型档位（`Auto` / `Ultimate` / `Fast` / `Efficient` 以及具体模型），面板实时显示累计 credits。运行中可随时中断。

**改动** — 任务跑完后按 `git diff HEAD` 复盘这次改了什么，包含新建的未跟踪文件。改动是**只读**的：这里只看，不在这里改，也不在这里提交。

**摘要** — 每轮结束后用一个便宜的模型档位，把「上轮摘要 + 这轮内容」折叠成一份滚动摘要，落盘为 markdown。成本因此是平的，不会随对话变长而膨胀。

**审批** — 写到文件的工具调用会弹卡片问你要不要放行，只读操作（`Read` / `Glob` / 只读 Bash）直接放过，所以不会一直被打断。

**护栏** — 工作区有未提交改动时，发送前会先列出来确认，避免 agent 的改动和你手上的未完成工作糊在一起。

## 安装

前置条件：Node，以及本机已登录 Qoder 账号（插件不碰账号，额度走 qodercli 的登录态）。

```bash
npm i -g @deepseek-ai/dsh          # 官方包，只认这个 scope
npm i -g @qoder-ai/qodercli        # 插件锁定的 CLI 版本为 1.1.81
qoder                              # 首次运行完成登录

git clone git@github.com:whalecome7/dsh-plugins.git
cd dsh-plugins
npm i                               # SDK 装在仓库根，供 packages/* 解析

# 把插件挂进 web profile（路径换成你本机的绝对路径）
dsh plugin --profile web add link:/absolute/path/to/dsh-plugins/packages/dsh-plugin-qoder
```

然后确认 `~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles` 里有 `dsh-plugin-qoder`，且**排在最后**：

```json
{
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-plugin-qoder"
      ]
    }
  }
}
```

`add link:` 通常会自己登记；没登记就手动加，否则插件装上了也不会被加载。

启动：

```bash
dsh web
```

默认监听 `http://127.0.0.1:3080`，端口被占用时用 `--port` 指定。打开终端打印的带 `?token=` 的地址（裸地址会被拒绝），右侧边栏会出现 **Qoder** 标签，首次访问会自动展开。

## 使用

三个视图切换：

| 视图 | 内容 |
| --- | --- |
| 对话 | 输入需求、看流式回复、处理审批卡片 |
| 改动 | 最近的 `git diff`，含新建的未跟踪文件 |
| 摘要 | 滚动摘要全文，同时落盘成 markdown |

输入框 `Enter` 发送、`Shift+Enter` 换行。顶部可切换模型档位、新建会话、中断当前轮次。

## 产物与配置

运行数据都在工作区的 `.dsh/qoder/` 下：

```
.dsh/qoder/summaries/<sessionId>.md   # 滚动摘要，一个会话一份
```

不要写 `.qoder/`——qodercli 把它当受保护的配置路径，agent 写进去会被内置的敏感路径保护拒绝。

环境变量：

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `DSH_QODER_CWD` | dsh 进程的 cwd | 指定 Qoder 操作的工作目录 |
| `DSH_QODER_SUMMARY_MODEL` | `Efficient` | 生成摘要用的模型档位；`Efficient` 实测 credits 为 0，`Fast` 约 0.008–0.015/次 |

## 注意事项

**改代码后要重启。** 插件不做热重载，改完 `lib/*.js` 必须重启 `dsh web` 才生效——包括客户端 bundle，它是在启动时扫描打包的。

**dsh 还是 rc 版。** 当前基于 `0.2.1-rc.5`，官方明确会有破坏性变更。插件接口若变动，先跑 `dsh --help` 确认实际用法，不要凭记忆写。

**credits 才是真数据。** 底层返回的 `usage.input` / `usage.output` 恒为 0，只有 credits 可信，别拿 token 数做成本估算。

**客户端服务的 inject 必须写全。** cordis 的 Context 是严格模式，访问没在 `exports.inject` 里声明的服务会直接抛异常，而这个异常会被 boot 吞成页面上的一句 `Failed to load plugins`，控制台里连堆栈都没有。踩过一次，排查方法写在 `AGENTS.md`。

## 仓库结构

```
package.json                    # 工作区根，SDK 装在这里
packages/dsh-plugin-qoder/      # Qoder 面板插件
  lib/index.js                  # 宿主端：9 个 /api/qoder.* 路由
  lib/qoder-manager.js          # 会话生命周期、事件日志、SSE、审批、中断
  lib/git-tools.js              # 脏工作区检查、HEAD diff
  lib/summary.js                # 滚动摘要落盘
  lib/client.js                 # 客户端 UI bundle（无构建，单文件）
packages/dsh-plugin-hello/      # 最小验证插件，仅作加载链路参考
.poc-sdk/                       # POC 与排查脚本（cdp-console.mjs / replay-client.mjs）
AGENTS.md                       # 开发约定、插件机制实证、踩坑记录
```

开发前建议先读 `AGENTS.md`，里面记了插件四件套的完整加载链路和几个必踩的坑。

## License

未声明。暂作个人项目使用。
