# dsh-plugin-qoder-assist

dsh 右侧边栏助手：旁路观察终端里的 qodercli 会话，支持实时镜像、会话摘要与复盘建议。AI 调用复用本机 qodercli 登录态，全部产物保存在本地。

## 能力

- **实时镜像**：自动发现 `~/.qoder/projects/*/*.jsonl`，按字节偏移增量读取，1 秒轮询 + SSE 推送。
- **独立页面**：左侧导航「Qoder 助手」进入全局面板，与会话右侧栏解耦；页面内左侧会话列表、右侧对话/摘要/设置。
- **全局单例数据层**：宿主每个 `dsh web` 进程一个 Hub；浏览器整页一个 EventSource 与一份状态。
- **会话列表**：跨项目列出全部会话，活跃会话置顶；默认选中最近活跃会话。
- **摘要**：手动生成或会话结束自动生成一次，落在 `~/.dsh/qoder-assist/summaries/`。
- **实时建议**：去抖 90 秒、每会话 6 次/小时、全局 200 次/天；建议以卡片内联在对话时间线中，带证据与有用/无用反馈。
- **hooks（可选）**：一键安装 4 个 qodercli hooks（`SessionStart` / `SessionEnd` / `PermissionRequest` / `Stop`），只补 transcript 里没有的事件；hook 失败不影响主链路。

## 安装

```bash
dsh plugin --profile web add link:/abs/path/to/packages/dsh-plugin-qoder-assist
```

如果本机 pnpm 开启了 `minimumReleaseAge` 策略，已有依赖可能让安装被拦；仅对本次安装放开：

```bash
dsh plugin --profile web add link:/abs/path/to/packages/dsh-plugin-qoder-assist --config.minimumReleaseAge=0
```

安装后重启 `dsh web`（插件不做热重载）。左侧导航会出现「Qoder 助手」入口，点击进入独立页面。

## 数据位置

```
~/.dsh/qoder-assist/
  summaries/<project>/<sessionId>.md
  suggestions/<sessionId>.jsonl
  state.json
  hooks.jsonl
  locks/
  logs/
  workspace/          # 分析会话的 cwd，保持为空
```

不向被观测的仓库写任何文件。

## 环境变量

| 变量 | 作用 |
| --- | --- |
| `DSH_QODER_ASSIST_NO_ANALYZE=1` | 只关分析（建议/摘要），不影响镜像，用于测试或省钱 |
| `DSH_QODER_ASSIST_MODEL` | 覆盖分析模型；缺省使用 qodercli 当前默认模型 |
| `DSH_QODER_ASSIST_CWD` | 覆盖面板显示的工作目录 |

## 安全边界

- 分析会话零工具，cwd 固定为空目录，只能读取我们组装的文本。
- 发送前对 `sk-`、`AKIA`、`ghp_`、`Bearer`、常见 `.env` 键名等做正则脱敏；落盘原文不动。
- 原始 transcript 只在本机读写。

## 已知限制

- `--no-session-persistence` 与 `--remote` 云会话不可见。
- 子代理（`subagents/*.jsonl`）不展开，仅能看到主会话里的 `Agent` 调用。
- 历史会话不自动回溯分析，摘要按需生成。
- 会话格式依赖 qodercli 版本；升级后若字段变化，面板会降级为只读并在状态条提示。

## 开发

```bash
node spike/transcript-spike.mjs --list          # 列出会话
node spike/transcript-spike.mjs --session <id>  # 监听指定会话
node spike/transcript-spike.mjs --from start    # 回放
```

设计细节见 [DESIGN.md](./DESIGN.md)。
