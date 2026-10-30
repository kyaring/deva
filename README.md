# Deva 无头版

**无图形界面的 AI Agent 服务。** 在服务器上常驻运行，通过 Telegram 或飞书对话，用命令行完成配置与管理。

- 单文件部署：编译为原生二进制（内含运行时），目标机器不需要 Node.js、Electron 或虚拟显示器。
- 常驻内存约 70 MB（bun 1.4.4，实测）。
- 数据、密钥与配置全部保存在数据目录中，备份和迁移只需要复制这一个目录和主密钥。

[English](README.en.md)

---

## 功能

**对话与工具**
- 对话支持续接（`ask --session`）与后台作业（`ask --background`，可查看进度、取消）。
- Agent 在挂载的工作区里读写文件、执行命令；取消时会中止模型回合并结束它启动的命令。
- 支持 MCP 服务（HTTP / SSE / stdio），请求头中的敏感值以加密引用保存。
- 模型服务：Anthropic、OpenAI、OpenAI Responses 协议，以及任何兼容 OpenAI 接口的服务。

**远程通道**
- Telegram：主人扫码认领机器人，之后用邀请码（`/pair`）添加其他人，可随时移除。已在服务器上完成端到端验证。
- 飞书：已接入，尚未在无头环境中完整验证。

**运维**
- `doctor` 逐项检查密钥能否解密、MCP 是否连通、机器人 Token 是否有效、模型是否可达、工作区是否存在。
- 管理命令在服务运行时经控制接口立即生效，服务停止时直接写入文件。
- 支持 HTTP、HTTPS 与 SOCKS5 代理，`NO_PROXY` 可排除本机和内网地址。

**安全**
- API Key、机器人 Token、MCP 令牌均使用 AES-256-GCM 加密保存，主密钥只放在环境变量文件中。
- 密钥只能从标准输入读入，不出现在命令行参数和日志里。
- 敏感请求头（名称含 auth、token、key、secret 等）拒绝写入明文，必须引用加密库中的值。

## 快速开始

```bash
pnpm install --frozen-lockfile
pnpm --filter @deva/desktop build:headless:bun                 # 生成 apps/desktop/out/headless/deva-headless
sudo install -m 0755 apps/desktop/out/headless/deva-headless /usr/local/bin/deva-headless

sudo deva-headless setup        # 选服务商 → 输入 API Key（不回显）→ 选模型
sudo deva-headless doctor       # 逐项检查配置是否真正可用
sudo deva-headless ask "用一句话介绍你自己"
```

正式部署（专用用户、systemd 开机自启、主密钥管理）见 [deploy/README.md](deploy/README.md)。

## 模型

一个服务商（例如上游的 `gitllc`）可以挂多个模型，默认模型只有一个，每个会话可以单独指定。

```bash
# 查看上游可用的模型（需已设置 API Key）
sudo deva-headless provider models gitllc

# 加入模型：逐个添加，或一次加入上游全部模型
sudo deva-headless provider model add gitllc glm-5.3
sudo deva-headless provider model add gitllc --all

# 切换默认模型（新对话、IM 对话立即使用）
sudo deva-headless provider use gitllc:glm-5.3

# 只给某个会话指定模型（之后用 --session 续接时沿用，不受默认模型切换影响）
sudo deva-headless ask --session <会话ID> --model gitllc:gemini-4-argon "<内容>"

sudo deva-headless provider list           # 查看所有服务商与模型，* 标记默认模型所在的服务商
```

规则：
- 新对话不写死模型，跟随默认模型；已有对话若用 `--model` 指定过，则保持指定的模型。
- `ask` 每次运行都会在 stderr 打印 `[模型] 服务商:模型`，便于确认实际使用的模型。
- `provider` 命令直接修改配置文件，**修改后需要重启服务**：`sudo systemctl restart deva-headless`。

## Telegram 指令

在与机器人的私聊中可以使用：

| 指令 | 说明 |
| --- | --- |
| `/new [角色]` `/list` `/use 序号` | 新建、列出、切换对话 |
| `/models` | 查看所有服务商与模型（★ 默认，▶ 本对话） |
| `/model 服务商:模型` | 切换本对话使用的模型 |
| `/model default 服务商:模型` | 设为默认模型（新对话立即生效） |
| `/model reset` | 本对话恢复跟随默认模型 |
| `/model add 服务商 模型ID` | 添加模型（`--all` 添加服务商的全部模型） |
| `/model remove 服务商 模型ID` | 删除模型（默认模型需先换掉） |
| `/stop` `/status` `/help` | 停止回复、查看当前对话、帮助 |

只有已配对的用户可以使用这些指令。

## 命令

| 命令 | 说明 |
| --- | --- |
| `setup` | 交互式向导：选择服务商、输入 API Key、选择模型 |
| `provider list \| add \| remove \| models \| model add \| model remove \| use` | 服务商与模型管理 |
| `set-key <服务商ID>` | 保存服务商的 API Key（从 stdin 读入） |
| `secret list \| set <键名> \| delete <键名>` | 加密密钥管理 |
| `mcp list \| add \| enable \| disable \| test \| remove` | MCP 服务管理；`--header 名=@secret` 引用加密密钥 |
| `telegram-add` | 添加 Telegram 机器人并认领主人 |
| `remote bots \| users \| pair-code \| pair-cancel \| remove-user` | 机器人与配对用户管理 |
| `ask [--session <ID>] [--background] [--timeout <秒>] <文本>` | 对话；`--session` 续接，`--background` 后台运行 |
| `job list \| status \| log \| cancel` | 后台作业管理 |
| `workspace show \| set <路径> \| unset` | 新对话默认挂载的工作区 |
| `serve` | 常驻运行（通常由 systemd 托管，同一数据目录只能运行一个实例） |
| `status` | 查看数据目录、密钥后端、服务商与机器人概况 |
| `doctor` | 全面验证配置 |

## 数据目录

默认为 `~/.deva`，由环境变量 `DEVA_HOME` 指定（部署时为 `/var/lib/deva`）。

```
config.json          服务商、模型、默认工作区、机器人等配置（非敏感）
mcp.json             MCP 服务定义（敏感值为引用）
secrets.json         加密保存的密钥
data/                会话、人设、技能等运行数据
jobs/                后台作业记录与输出
workspace/projects/  开发项目
workspace/scratch/   临时文件与测试产物
control.sock         服务的本地控制接口（权限 0600）
```

主密钥通过环境变量 `DEVA_MASTER_KEY`（32 字节的 base64）提供，也可以使用数据目录下权限为 0600 的 `master.key`。丢失主密钥将无法解密已保存的密钥，请务必备份。

## 安全须知

- `run_command` 和文件工具没有命令白名单，权限与运行服务的用户相同。请使用专用的低权限用户运行，不要用 root。
- Telegram 机器人只接受已认领的主人以及主人邀请的人。Bot Token 与模型 Key 只通过终端设置，不要发到聊天里。
- 如果密钥或令牌曾经出现在聊天记录或日志中，请立即在对应平台轮换。

## 已知限制

- 无头版不做图片缩放，超过大小上限的图片会被拒绝。
- 编译后的单文件约 123 MB（内含 bun 运行时）。
- 定时任务、远程通道只在 `serve` 运行期间生效。
- 没有图形界面，因此不提供终端面板等桌面功能。

## 开发

- 服务层与无头入口位于 `apps/desktop/src/main/headless/`（启动流程 `boot.ts`，命令实现 `*-cli.ts`，Electron 替代层 `electron-shim.ts`）。
- 构建脚本：`pnpm --filter @deva/desktop build:headless`（Node 可运行的 bundle）与 `build:headless:bun`（单文件二进制）。
- 类型检查：`pnpm exec tsc --noEmit -p apps/desktop/tsconfig.node.json`。

## 许可

[MIT](LICENSE)
