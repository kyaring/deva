# deva 优化意见

> 编写日期：2026-10-29　｜　运行主机：wjy5010u（4 核 / 7.8 GB 内存）　｜　服务：`deva-headless.service`（用户 `deva`）

## 1. 背景与现状

- 运行形态：部署的是打包产物 `/opt/deva/deva-headless.cjs`（约 8.7 MB），由 systemd 启动，`DEVA_MASTER_KEY` 与代理设置来自 `/etc/deva/deva.env`。
- 资源占用：空闲时 RSS 约 97 MB，CPU 约 0.1%，资源不是瓶颈。
- 配置位置：`/var/lib/deva/config.json`（机器人、模型、replyMode 等），`/var/lib/deva/mcp.json`（MCP 服务），`/var/lib/deva/secrets.json`（加密存储）。

## 2. 发现的问题

### 2.1 【最高优先级】源码与部署产物不一致

本轮对 Telegram 适配器和 MCP 的所有修改都直接打在了打包文件上，源码仓库（`apps/`）没有对应改动。后果：

- 下次从源码构建或升级部署时，这些修改会全部丢失。
- 仓库无法反映线上真实行为，代码审查和回归测试都无从谈起。

已在线上生效、需要回填到源码的改动：

| 功能 | 改动位置（打包文件中的逻辑） |
|---|---|
| Telegram 话题（forum topic）会话隔离 | `call()` 拆分 `chatId#threadId`，`sendMessage` 带 `message_thread_id`；`onMessage` / `onCallback` 接受 group/supergroup，并把话题编号编入 chatId |
| 回合结束时发送新消息并删除流式旧消息 | Telegram `renderTurn`：`finished` 时 `upsert` 新消息，再 `deleteMessage` 旧消息 |
| MCP 会话过期自动重连 | `dispatchMcpTool` 的 catch 分支：`isSessionExpiredErr` 命中后 `reconnectMcp` 并重试一次；`reconnectMcp` 合并并发请求 |

### 2.2 MCP 认证配置缺失（已修复，但暴露了配置层问题）

`mcp.json` 中 `vps-commander` 条目没有 `headers` 字段，而令牌其实已存在于 `secrets.json`（键 `mcp:vps-commander:Authorization`）。连接时不带认证头，服务端返回 401。已通过添加 `secretRef` 修复。

问题本质：**配置没有 schema 校验**，缺字段不会报错，只会在运行时静默失败。

### 2.3 错误被静默吞掉

打包代码中存在多处 `.catch(() => void 0)`，例如删除旧消息失败时没有任何日志。线上出现"重复消息""工具调用无响应"时，几乎无法定位。

### 2.4 MCP 会话失效后只能被动恢复

原实现只在传输层 `onclose` 时重连。会话服务端过期但连接未断开时，客户端会持续显示"已连接"，所有工具调用失败。（已在打包产物中加入被动重连，仍缺少主动探活。）

### 2.5 会话体积持续增长

绑定的私聊会话文件已达约 837 KB（`sess_mvllwxsv_i5vz.json`）。每轮请求携带的历史越来越长，直接推高 token 成本和首字延迟。

### 2.6 运维层面

- systemd 单元未设置 `RestartSec`、`StartLimitBurst`、`MemoryMax`。
- journald 未设置大小上限。
- `/root/backups/` 下的备份目录不断累积（已有 deva-code、deva-mcp、deva-final、socks-switch 等多组），没有保留策略。
- 临时调试日志（`[tg-dbg]`）曾经打进线上版本，说明缺少"调试代码不得合入"的检查。

### 2.7 网络与代理

- wjy5010u 外网只能经 SOCKS 代理出口，Telegram 的 HTTP CONNECT 路径曾出现稳定失败，SOCKS5 则正常。
- 源码最近一次提交 `4a3673c` 已把全局 fetch 改走 SOCKS 出口并增加一次重试，这与线上当前的代理配置是相符的，需要确认线上版本已包含该提交。

## 3. 优化方案

### P0：回归源码（必须先做）

1. 把 2.1 中的三组改动整理为源码提交，放到 `apps/` 对应的 Telegram 适配器和 MCP 模块中。
2. 用源码重新构建，产物与线上 `deva-headless.cjs` 做差异对比，确认只有预期差异。
3. 构建产物替换线上文件的流程固定为：构建 → 语法检查 → 备份旧产物 → 替换 → 重启 → 冒烟测试。
4. 此后禁止直接修改 `/opt/deva/` 下的文件。

### P1：配置校验与可观测性

1. 为 `mcp.json` 增加 schema 校验：`transport=http` 时必须有 `url`；需要认证的服务必须声明 `headers`，并检查对应 `secretRef` 在 `secrets.json` 中存在。启动时校验，失败则在日志中明确报错。
2. 去掉 `.catch(() => void 0)`，改为记录带上下文的日志（不含令牌与消息内容）。
3. 增加 MCP 健康检查：每 60 秒对已启用的服务执行轻量请求（如 `tools/list`），连续失败两次则主动重连。
4. 调试日志通过编译开关控制，正式构建中不包含。

### P2：会话体积控制

1. 会话超过阈值（例如 200 KB 或 80 轮）时，把较早的历史压缩为摘要，保留最近若干轮原文。
2. 压缩前后各保存一份快照，便于回溯；压缩效果需要在测试会话中先验证回答质量。
3. 不活跃超过 30 天的会话归档，清理 `_index.json` 中的失效条目。

### P3：Telegram 体验

1. `minUpdateMs`（当前固定 1200 ms）改为配置项，默认值保持不变。
2. 对 429 限流和超时做指数退避，遵守 `retry_after`。
3. 删除旧消息失败时记录日志，并在下一条回复中不再重复发送完整内容。

### P4：运维加固（风险低，可立即做）

1. systemd 单元增加：
   ```
   Restart=on-failure
   RestartSec=5
   StartLimitIntervalSec=300
   StartLimitBurst=5
   MemoryMax=768M
   ```
2. journald 设置 `SystemMaxUse=500M`。
3. 备份保留策略：代码与配置备份各保留最近 10 份，超出部分由脚本自动清理。
4. 把 `mcp.json`、`deva.env` 的结构（键名，不含值）记录在本文档附录中，方便审计。

### P5：邮件能力接入的前置条件

接入 mail-mcp（Gmail / Microsoft 365 OAuth2）之前需要先完成：

- P0（源码与产物一致），否则新增的 MCP 配置无法通过构建保留。
- P1 中的 MCP schema 校验，OAuth 令牌需要 `secretRef` 管理。
- 资源评估：mail-mcp 需要至少一个 IMAP 账号才能启动，实测需要用真实账号的配置补充测量，目前尚未完成。
- 代理：IMAP/SMTP 直连 TCP，不读取 `all_proxy`，需要确认出口方式。

## 4. 建议执行顺序

1. **P0**：源码回填与构建一致性（工作量最大，收益最高）。
2. **P4**：systemd、journald、备份保留（风险低，立即可做）。
3. **P1**：配置校验、错误日志、MCP 健康检查。
4. **P2**、**P3**：会话压缩与 Telegram 行为调整（需要逐项验证）。
5. **P5**：邮件能力，在前四项稳定之后再做。

## 5. 风险提示

- 任何修改前必须备份，并通过语法检查。
- 会话压缩会改变模型上下文，可能影响回答质量。
- 修改编辑频率前需要验证 Telegram 限流阈值。
- P0 之前的所有线上修改都依赖具体的打包产物，升级前请先按第 2.1 节清单逐项核对。

## 附录：待确认事项

- 线上产物是否已包含源码提交 `4a3673c`（SOCKS 全局 fetch）。
- 群话题功能的测试结论（用户已确认通过，需要记录到变更日志中）。
- MCP 自动重连补丁是否需要在正式版本中保留 `\b404\b` 这类宽匹配规则，建议收窄。
