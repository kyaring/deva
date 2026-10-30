# Deva 无图形界面部署（Linux 服务器）

Deva 的 Agent 能力（对话、工具、MCP、定时任务、Telegram / 飞书远程通道）可以脱离桌面窗口运行。
构建产物是一个单文件二进制 `deva-headless`（内含 bun 运行时），不需要 Node.js、Electron、显示器或 Xvfb。

## 0. 系统依赖

- 服务本身不需要 Node.js：运行的是单文件二进制 `/opt/deva/bin/deva-headless`。
- 构建机需要 Node.js 20+ 与 pnpm（生成 bundle 并用 bun 编译）。
- 开发工具（供 Agent 使用）：npm（`apt install npm`）、corepack（pnpm），缓存目录为 `/var/lib/deva/.cache/corepack`（服务单元里的 `COREPACK_HOME`）。

## 1. 构建

```bash
pnpm install --frozen-lockfile
pnpm --filter @deva/desktop build:headless:bun  # 生成 apps/desktop/out/headless/deva-headless（单文件原生二进制，内含 bun 运行时，目标机器不需要 Node）
```

## 2. 安装（已在 wjy5010u 上按此执行）

```bash
# 专用用户（无登录 shell）与数据目录
sudo useradd --system --home-dir /var/lib/deva --create-home --shell /usr/sbin/nologin deva

# 程序
sudo install -d -m 0755 /opt/deva
sudo install -d -m 0755 /opt/deva/bin
sudo install -m 0755 apps/desktop/out/headless/deva-headless /opt/deva/bin/deva-headless

# 环境变量：主密钥（唯一来源）与代理，root 拥有、0600
sudo install -d -m 0700 /etc/deva
sudo install -m 0600 deploy/deva.env.example /etc/deva/deva.env   # 然后编辑：填 DEVA_MASTER_KEY，按需设代理

# 管理命令包装脚本（以 deva 用户、同一环境运行 CLI）
sudo install -m 0755 deploy/deva-headless /usr/local/bin/deva-headless

# systemd 服务（开机自启）
sudo install -m 0644 deploy/deva-headless.service /etc/systemd/system/
sudo systemd-analyze verify /etc/systemd/system/deva-headless.service
sudo systemctl daemon-reload
sudo systemctl enable --now deva-headless
```

主密钥只放在 `/etc/deva/deva.env` 里，不要在数据目录中留副本。生成密钥：`openssl rand -base64 32`。

## 3. 运行与管理

```bash
systemctl status deva-headless          # 状态
journalctl -u deva-headless -f          # 日志
sudo systemctl restart deva-headless    # 修改配置后重启

sudo deva-headless status               # 管理命令都通过 deva-headless 包装脚本运行（需要 sudo）
```

服务由 systemd 管理，**不要**用 `deva-headless serve` 手动启动（会被单实例锁拒绝）。

## 3.5 工作区布局

Agent 的文件与代码都放在独立的工作区里，与运行数据分开：

```
/var/lib/deva/                      数据目录（配置、加密密钥、会话、人设、技能）— 由服务管理，勿手动改
/var/lib/deva/workspace/            工作区（IM 新对话的默认挂载点）
/var/lib/deva/workspace/projects/   开发项目（每个仓库一个子目录）
/var/lib/deva/workspace/scratch/    临时文件、测试产物
```

```bash
sudo deva-headless workspace show                       # 查看当前默认工作区
sudo deva-headless workspace set /var/lib/deva/workspace
sudo systemctl restart deva-headless                    # 设置后重启生效
```

设置后，之后新开的对话（Telegram 里发送 `/new`，或 `ask`）会挂载到该目录，命令默认在它下面执行。
已有的对话保留原来的挂载，需要切换时发送 `/new`。

## 3.6 密钥、MCP 与验证

密钥只通过终端输入（stdin），不放在命令行参数和配置文件里：

```bash
echo "<值>" | sudo deva-headless secret set <键名>   # 加密保存
sudo deva-headless secret list                       # 只列键名
sudo deva-headless secret delete <键名>
```

MCP 服务的请求头如果是敏感信息，写 `@secret` 引用，值放进加密库，键名为 `mcp:<id>:<请求头名>`：

```bash
sudo deva-headless mcp add <id> --name <名称> --transport http --url <地址> --header Authorization=@secret --enable
echo "Bearer <令牌>" | sudo deva-headless secret set mcp:<id>:Authorization
sudo deva-headless mcp test <id>                    # 走与服务相同的连接路径，列出工具
sudo deva-headless mcp list | enable <id> | disable <id> | remove <id>
```

敏感请求头（名称含 auth / token / key / secret 等）不允许写明文，会被拒绝。

**验证整套配置**（推荐每次改动后执行）：

```bash
sudo deva-headless doctor      # 检查服务、密钥解密、MCP 连接、机器人 Token、默认模型与工作区
```

服务运行中时，上述写操作经控制接口交给服务执行，立即生效；服务未运行时直接写入文件，启动后生效。
手动编辑 `/var/lib/deva` 下的文件后，需要重启服务。

## 3.7 对话、续接与后台作业

```bash
sudo deva-headless ask "<任务>"                        # 前台：流式输出，结束后打印会话 ID
sudo deva-headless ask --session <会话ID> "<后续>"     # 续接同一会话（沿用它的工作区与模型）
sudo deva-headless ask --timeout 600 "<任务>"          # 超时自动中止（秒）
sudo deva-headless ask --background "<长任务>"         # 后台：立即返回作业 ID

sudo deva-headless job list                            # 所有作业
sudo deva-headless job status <作业ID>                 # 状态、会话、最近错误
sudo deva-headless job log <作业ID> [行数]             # 输出
sudo deva-headless job cancel <作业ID>                 # 取消：中止回合并结束它启动的命令
```

- 同一会话同一时间只允许一个回合：会话在后台运行时，前台和其它后台请求都会被拒绝，直到作业结束或被取消。
- 作业文件保存在 `$DEVA_HOME/jobs/`（元数据 `.json`、输出 `.out`、错误 `.err`）。服务重启不影响已经完成的作业记录。

## 4. 配置

首次配置推荐直接运行向导（需要在终端里交互式执行，API Key 输入时不显示）：

```bash
sudo deva-headless setup        # 选服务商 → 输入 API Key → 选模型（自动拉取清单）→ 设为默认
```

之后的日常管理用 `provider` 子命令，适合脚本化或远程批量操作：

```bash
sudo deva-headless provider list                                   # 服务商、密钥状态、模型与默认模型
sudo deva-headless provider add myproxy --adapter openai --host https://example.com/v1 --name "我的代理"
sudo deva-headless provider add anthropic                          # 添加官方预设（只写连接信息，不含模型）
echo "sk-…" | sudo deva-headless set-key myproxy                   # 保存 API Key（加密）
sudo deva-headless provider models myproxy                         # 从服务商拉取可用模型
sudo deva-headless provider model add myproxy <模型ID>
sudo deva-headless provider use myproxy:<模型ID>                   # 设为默认模型
sudo deva-headless provider remove myproxy                         # 删除服务商（连同其密钥）
echo "123:AAH…" | sudo deva-headless telegram-add                  # 认领 Telegram 机器人（终端打印二维码，手机上点 Start）
```

修改配置后，需要重启服务：`sudo systemctl restart deva-headless`。

### 机器人与配对用户

Telegram 的机器人身份由 BotFather 决定，主人通过认领获得权限；之后要加人或移除人，用 `remote` 命令：

```bash
sudo deva-headless remote bots                              # 查看机器人
sudo deva-headless remote users @okbbybot                   # 查看已配对用户（含用户 ID）
sudo deva-headless remote pair-code @okbbybot               # 生成邀请码（需要 serve 运行中）
#   新用户在 Telegram 里给机器人发送：/pair <邀请码>
sudo deva-headless remote pair-cancel @okbbybot             # 作废当前邀请码
sudo deva-headless remote remove-user @okbbybot <用户ID>    # 移除用户，之后发消息需重新配对
```

生成与取消邀请码需要服务运行中（通过 `$DEVA_HOME/control.sock` 与服务通信，权限 0600，仅本机进程可用）；
移除用户在服务未运行时直接修改配置。

## 5. 运行

```bash
sudo deva-headless ask "现在几点？"                         # 单次对话，用来验证模型与工具是否可用
sudo systemctl daemon-reload
sudo systemctl enable --now deva-headless
journalctl -u deva-headless -f
```

`telegram-add` 之后需要重启服务（`systemctl restart deva-headless`）才会连接新机器人。

## 注意

- **安全**：`run_command` 与文件工具不设任何限制。通过 Telegram / 飞书来的指令，权限等同于运行服务的用户。
  请使用专用的低权限用户（本文档使用 `deva`），不要用 root 运行，并只把主人本人配对进来。
- **密钥**：密钥以 AES-256-GCM 加密保存，主密钥来自 `DEVA_MASTER_KEY`（或数据目录下权限为 0600 的 `master.key`）。
  这是文件级保护：能同时读到密文与主密钥的人可以解密。请把 `/etc/deva/deva.env` 权限设为 0600，并妥善备份主密钥。
- **代理**：`HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` 支持 `socks5://` 与 `http://`；`NO_PROXY` 命中的主机直连。作用于 Telegram 与模型服务的网络请求；飞书 SDK 使用自己的 HTTP 栈，暂不经过该代理。
- **图片**：无头版不做图片缩放，超过大小上限的图片会被拒绝。
- **定时任务**：只在服务运行期间触发；错过的任务在下次启动时只补跑最近一次（与桌面版相同）。
