# dsh-plugin-qoder-assist 设计文档

> 定位：辅助日常用 qodercli 开发的 DSH 插件。第一期做终端会话的实时镜像、复盘摘要与实时建议；后续可扩展额度展示等提效功能。

## 1. 目标与非目标

### 目标

- **A 实时镜像**：dsh 右侧面板实时展示终端里 qodercli 会话的对话与工具调用。
- **B 复盘**：按需生成会话摘要，会话结束自动生成一次终局摘要，落盘可回看。
- **C 实时建议**：会话进行中，以增量方式分析对话，产出 1~3 条带证据的建议。
- AI 调用全部走本机 qodercli 登录态（Qoder Agent SDK daemon query）。

### 非目标（第一期）

- **不做回写**：不把建议注入回 qodercli 会话，不替用户操作终端。
- **不处理云会话**：`--remote` 会话不纳入。
- **不处理无持久化会话**：`--no-session-persistence` 的会话不落盘，面板明示不支持。
- **不做历史全量回溯分析**：历史会话按需生成摘要，不自动排队跑建议。
- **不做额度展示**：后续单独验证登录态下的额度接口。
- **不做子代理展开**：子代理独立 transcript 不展示，列为后续候选。

## 2. 关键事实依据（qodercli 1.1.81 实测）

- 会话主记录：`~/.qoder/projects/<转义 cwd>/<session-id>.jsonl`，每行一条 JSON，含 `user` / `assistant` / `attachment` / `system` / `active-leaf` 等类型，assistant 记录带 `stop_reason`。
- `stop_reason` 语义：`tool_use` 表示继续（还要调工具），`end_turn` / `stop_sequence` / `max_tokens` 才是回合结束；大量 assistant 记录的 `stop_reason` 为 `null`（中间消息）。
- 会话 `state.json` 的 `workspaceDirectories[0]` 是真实 cwd；目录名转义（`-` → `/`）有歧义（`dsh-plugins` 会被解成 `dsh/plugins`），不能用目录名反解。
- 同名的 `<session-id>/` 目录只放 `state.json`、`compression-v2/` 等状态，`state.json` 含 `createdAt` / `updatedAt` / `workspaceDirectories`。
- 子代理记录在 `<session-id>/subagents/*.jsonl`。
- hooks 支持事件：`SessionStart`、`UserPromptSubmit`、`PreToolUse`、`PostToolUse`、`Stop`、`SubagentStop`、`SessionEnd`、`PreCompact`、`PostCompact`、`PermissionRequest`、`Notification`。
- hook stdin payload 含 `session_id`、`transcript_path`、`hook_event_name`，**不含对话正文**，因此 hook 不能当数据管道。
- dsh 插件侧能力：`ctx.connection.fetch.register` 支持流式 `Response`（SSE）；共享模块表里可直接 `require('react')`。

## 3. 架构

```
qodercli (终端)
  ├─ 写 ~/.qoder/projects/**/*.jsonl        ← 唯一真相源
  └─ hooks → cat >> ~/.dsh/qoder-assist/hooks.jsonl   ← 仅事件信号

dsh-plugin-qoder-assist (宿主端)
  ├─ scanner     扫描项目/会话，解析增量 JSONL（字节偏移）
  ├─ watcher     fs.watch + 2s 轮询兜底
  ├─ analyzer    SDK daemon query，增量分析，产出摘要/建议
  ├─ quota       去抖、每会话/全局配额、并发闸门
  └─ routes      /api/qoder-assist/*（HTTP + SSE）

客户端
  ├─ 左侧入口：「Qoder 助手」全局面板
  ├─ 独立页面：左侧会话列表 + 右侧详情
  ├─ 对话视图（分页 + 实时追加 + 内联建议卡片）
  ├─ 摘要视图
  └─ 顶部状态条 / hooks 安装入口
```

数据流：

1. watcher 发现文件增长 → 按偏移读取新增行 → 解析成消息 → 写入内存模型 → SSE 推「有新消息」。
2. 客户端收到小事件后按需拉增量，不通过 SSE 传大段文本。
3. analyzer 读取「上次分析偏移之后的新增内容」+ 滚动摘要 → 调 SDK → 建议/摘要落盘 → SSE 推「有新建议」。
4. hook 事件被解析后只做三件事：标记会话起止、触发终局摘要、在面板展示"终端需要确认"。

## 4. 数据模型与存储

根目录 `~/.dsh/qoder-assist/`：

| 文件/目录 | 内容 | 留存 |
| --- | --- | --- |
| `summaries/<转义项目名>/<sessionId>.md` | 会话摘要（手动 + 终局） | 长期 |
| `suggestions/<sessionId>.jsonl` | 建议追加写 | 每会话 200 条，整体 30 天清理 |
| `state.json` | 已读偏移、分析偏移、分析会话 id、配额计数 | 覆盖写 |
| `hooks.jsonl` | hook 原始 payload | 5MB 轮转 |
| `locks/<sessionId>.lock` | 跨进程分析互斥 | 5 分钟自动过期 |
| `logs/` | 运行日志 | 按天轮转 |

约束：**不往被观测的项目仓库里写任何文件**。

会话发现规则：

- 扫描 `~/.qoder/projects/*/*.jsonl` 为主会话。
- 排除分析会话所属项目目录（分析会话 cwd 固定为 `~/.dsh/qoder-assist/workspace`）。
- 同时按分析会话首条 prompt 的固定标记做二次过滤。
- 子代理 `subagents/*.jsonl` 不参与会话列表。

活跃判定：

- `state.json.updatedAt` 或 transcript mtime 在 5 分钟内 → 活跃。
- `SessionStart` / `SessionEnd` 到达后，以 hook 为准修正。

## 5. Hook 设计

安装方式：面板按钮「安装 hooks」，手动触发，不自动执行。

- 写入 `~/.qoder/settings.json`，用户级，幂等合并，仅新增/删除自己注册的条目（按 command 路径匹配）。
- 写入前备份 `settings.json.bak`。
- 注册 4 个事件：`SessionStart`、`SessionEnd`、`PermissionRequest`、`Stop`。
- 不触碰用户已有的 `Notification` / `Stop` 条目（与现有 `notify.sh` 共存，合并到同一事件的不同条目，不覆盖）。

hook 命令形态：

```sh
cat >> "$HOME/.dsh/qoder-assist/hooks.jsonl"
```

- 不解析、不联网、不依赖 node/jq，保证 <10ms 返回并 `exit 0`。
- 目录不存在时 hook 自行 `mkdir -p`，失败也不阻塞。
- 解析全部在 dsh 侧完成。

降级原则：hook 失效只影响权限提醒与会话起止精度，不影响 A/B/C 主链路。

## 6. 分析会话

- 每个 qodercli 会话对应一条持久分析会话，通过 SDK `options.resume` 续接，只喂增量。
- 上下文膨胀或 qodercli 侧发生压缩时，用滚动摘要重建一条新分析会话。
- 分析会话**零工具**：不给 `Read` / `Bash` / 写类工具，cwd 固定空目录，只接收组装好的「摘要 + 增量」文本。
- 分析会话在面板中隐藏，并在首条 prompt 打固定标记，扫描时过滤。
- 多个 dsh 实例共享 `~/.dsh/qoder-assist/`：分析前用 `locks/<sessionId>.lock`（`wx` 创建，5 分钟过期）互斥，拿到锁后重新校验去抖，避免同一会话被并发分析两遍。
- 环境变量 `DSH_QODER_ASSIST_NO_ANALYZE=1` 只关分析、不影响镜像，用于测试与省钱模式。
- 分析 prompt 明确角色：旁观分析者，结论必须基于给定对话，不臆测未出现的文件。
- 输入包含最近两轮已给出的建议，要求不得重复。
- 模型使用 qodercli 当前默认模型，不在插件内硬编码。

`permissionMode` 只使用合法值：`default` / `acceptEdits` / `auto` / `bypassPermissions`；daemon query 不支持 `dontAsk`。零工具前提下实际不会触发审批。

## 7. 触发与配额

| 项 | 默认值 |
| --- | --- |
| 去抖 | 距上次分析 ≥ 90s，且新增 ≥ 2 条消息或 ≥ 1 次写类工具调用 |
| 每会话配额 | 6 次/小时 |
| 全局日配额 | 200 次/天（可配） |
| 分析并发 | 全局 1，队列上限 3，超出丢弃并记日志 |
| 终局摘要兜底 | 10 分钟无新增且未收到 `SessionEnd` → 视为结束，补跑一次 |

终局摘要只跑一次，之后该会话不再自动触发分析。

## 8. UI

- **左侧全局入口 + 独立页面**：注册 `sidebar.panellist`（入口，order 20，图标 + 「Qoder 助手」）和 `main`（keyed 页面）。点击左侧入口进入独立页面，不占用 dsh 会话右侧栏。
- **客户端数据层是模块级单例**：整页只有一个 EventSource、一份状态与轮询；页面切走再回来不重建连接。
- 页面布局：左侧 290px 会话列表（活跃标记、项目名、最后活动时间），右侧详情区（对话 / 摘要 / 设置）。
- 会话选择：点列表切换，默认选中最近活跃会话；当前 dsh 工作目录的会话置顶。
- 对话视图：首屏尾部 512KB 或最后 200 条；上翻分页；`tool_result` 截断 4KB 可展开。
- 建议卡片：内联在对话时间线对应位置，可折叠；每条一行结论 + 一行可跳转证据；`有用` / `无用` 本地记录；滚动可见即标记已读。
- 不弹通知、不出声（终端侧 notify 已负责提醒）。
- 顶部状态条：分析暂停原因、格式不兼容提示；顶栏提供刷新与分析入口。

## 9. 安全与隐私

- 所有原始 transcript 仅在本地读写。
- 发送给分析模型前做密码类正则脱敏：`sk-`、`AKIA`、`ghp_`、`Bearer`、常见 `.env` 键名等替换为 `[REDACTED]`。
- 脱敏只作用于发送内容，落盘原文不动。
- 分析会话零工具 + 空 cwd，降低 prompt 注入造成实际破坏的可能。

## 10. 失败与降级

分层处理：

1. **读对话**永远可用：坏行跳过并计数，绝不整页白屏。
2. **分析**失败只影响建议/摘要，状态条说明原因；连续失败 3 次自动暂停，不无限重试。
3. **hook** 失效退化为活跃窗口推断。
4. 启动时读 `~/.qoder/bin/qodercli/version.txt` 与最近一个 JSONL 的字段样本，schema 不符时状态条提示并降级为只读。

## 11. 里程碑与验收

### Spike（已完成）

`spike/transcript-spike.mjs` 只读观测会话文件，已验证：

- 消息逐条追加，按字节偏移增量读取可行。
- 半行写入（append 尚未写完换行）可被缓冲，换行到达后正确拼接。
- 回合结束可用 `stop_reason in {end_turn, stop_sequence, max_tokens}` 判定。
- 并发轮询必须串行化，否则同一段字节会被重复解析。
- 文件 inode 变化 / 截断需重置偏移。
- `--resume` 在原 session JSONL 上追加：实测同一文件 45098B → 48132B，追加了 user 与新 assistant（`end_turn`），监听进程实时打印了偏移前进。

### M1 只读镜像

会话发现、列表、实时追加、分页、状态条、分层降级。

验收：

- 同时开 2 个终端会话，面板均可见。
- 新消息 2 秒内出现。
- 刷新页面 / 重启 dsh 后读取位置不丢。
- 单条超大工具输出不导致卡死。

### M2 复盘

按需摘要、终局摘要、落盘、配额闸门、重试。

验收：

- 摘要生成后重启仍在。
- 配额闸门生效，超限降级为手动可用。
- 分析会话不出现在会话列表。
- 10 分钟兜底能补出终局摘要。

### M3 实时建议

hook 安装/卸载、分析会话续接与重建、增量触发、内联卡片、有用/无用。

验收：

- 卸载 hook 后主链路不受影响。
- 建议证据可跳转到对应消息。
- 连续触发能正确去抖，重复建议被抑制。

建议的验收只卡结构与去抖，不卡内容质量。

## 12. 风险

- **格式漂移**：qodercli 升级可能改 JSONL 字段。解析层按"未知字段忽略、坏行跳过"编写，配合版本自检。
- **建议噪音**：实际使用后可能需要调 prompt 与触发门槛，不涉及架构。
- **额度**：所有分析消耗用户自己的账号，配额默认值在实测一周后调整。
- **子代理推理缺失**：主线上只见 `Agent` 调用，复盘时可能缺子代理内部推理。

## 13. 开放问题

- 登录态下额度信息的获取方式（接口、频率、是否可缓存）。
- 子代理对话折叠进主会话（M3 之后候选）。
- 建议卡片的"采纳"是否需要回写到本地笔记（暂不做）。
