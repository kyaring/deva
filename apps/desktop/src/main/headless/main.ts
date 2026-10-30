/**
 * Deva 无图形界面入口（headless）：只运行 Agent 的服务层——对话、工具、MCP、定时任务、
 * 远程通道（Telegram / 飞书）。不创建窗口、托盘与终端，不依赖 Electron 运行时（见 electron-shim.ts）。
 *
 * 子命令：
 *   serve                 常驻运行（默认）：调度器 + 已启用的远程机器人
 *   status                打印数据目录、密钥后端、服务商与机器人概况
 *   set-key <providerId>  从 stdin 读取 API Key，加密保存
 *   telegram-add          从 stdin 读取 @BotFather 的 Token，终端打印认领二维码，等待主人在 Telegram 点 Start
 *   ask [选项] <文本…>    对话：--session <id> 续接，--background 后台运行，--timeout <秒>
 *   job list|status|log|cancel   后台作业管理
 *   setup                 交互式向导：选服务商 → 输入 API Key → 选模型 → 设为默认（推荐首次使用）
 *   provider …            服务商与模型管理（list / add / remove / models / model add|remove / use）
 *   remote …              机器人与配对用户（bots / users / pair-code / pair-cancel / remove-user）
 *   workspace …           IM 新对话的默认工作区（show / set <路径> / unset）
 *   secret …              加密密钥（list / set <键名>（stdin）/ delete）
 *   mcp …                 MCP 服务（list / add / remove / enable / disable / test）
 *   doctor                逐项验证密钥、MCP、机器人、模型与工作区是否真正可用
 *
 * 数据目录由 DEVA_HOME 决定（默认 ~/.deva），与桌面版使用同一套格式，可直接迁移。
 */
import { randomInt } from 'node:crypto'
import { join } from 'node:path'
import QRCode from 'qrcode'
import { app, setQuitHandler } from './electron-shim'
import { getConfig, getDevaHome } from '../services/config'
import { } from '../services/workspace'
import { getSecretsStorageStatus, setSecret } from '../services/secrets'
import { } from '../services/provider'
import { hasActiveTurns, settleActiveTurns } from '../services/chat'
import { } from '../services/chat-bus'
import { resolveDefaultModel } from '../services/model-resolve'
import { } from '../services/checkpoints'
import { } from '../services/subagent-store'
import { } from '../services/media-store'
import { } from '../services/profile'
import { } from '../services/memory'
import { disconnectAllServers } from '../services/mcp'
import { } from '../services/attachments'
import { } from '../services/git'
import { } from '../services/clipboard'
import { } from '../services/deliverables'
import { } from '../services/tasks'
import { } from '../services/scheduler'
import { stopAllChannels } from '../services/remote'
import { fetchTelegramMe } from '../services/remote/telegram'
import { startTelegramLink } from '../services/remote/telegram-onboard'
import { DEFAULT_SCOPE, addBot, listBots } from '../services/remote/store'
import { runProviderCommand, runSetup } from './providers-cli'
import { runRemoteCommand } from './remote-cli'
import { runWorkspaceCommand } from './workspace-cli'
import { runAdminCommand } from './admin-cli'
import { runAsk, runJob } from './ask-cli'
import { boot, exitClean } from './boot'
import { installNetworkFetch } from './electron-shim'
import { } from '../services/remote/hub'
import { startControlServer } from './control'

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8').trim()
}

function fail(message: string, code = 1): never {
  console.error(message)
  process.exit(code)
}

// ───────── serve ─────────

let stopping = false
/** 无 Electron 事件循环保活：没有活跃句柄时 Node 会直接退出，这里显式保持常驻，退出时由 shutdown 清理。 */
let keepAlive: NodeJS.Timeout | null = null
let stopControl: (() => void) | null = null

async function shutdown(code: number): Promise<void> {
  if (stopping) return
  stopping = true
  console.info('[headless] 正在退出…')
  if (keepAlive) clearInterval(keepAlive)
  stopControl?.()
  if (hasActiveTurns()) await settleActiveTurns(3000)
  await Promise.allSettled([disconnectAllServers(), stopAllChannels()])
  process.exit(code)
}

function cmdServe(): void {
  if (!app.requestSingleInstanceLock()) fail('已有 Deva 无头实例在运行（同一数据目录只能运行一个）。')
  boot('serve')
  setQuitHandler(() => void shutdown(0))
  process.on('SIGTERM', () => void shutdown(0))
  process.on('SIGINT', () => void shutdown(0))
  keepAlive = setInterval(() => undefined, 60_000)
  stopControl = startControlServer(join(getDevaHome(), 'control.sock'))
  console.info(`[headless] Deva 已启动（无图形界面），数据目录：${getDevaHome()}`)
  const st = getSecretsStorageStatus()
  if (!st.available) {
    console.warn(
      `[headless] 密钥存储不可用（${st.reason}，后端 ${st.backend ?? '无'}）。请设置 DEVA_MASTER_KEY 后重启。`
    )
  }
}

// ───────── status ─────────

function cmdStatus(): void {
  boot('oneshot')
  const models = (getConfig().models ?? {}) as { providers?: { id?: unknown; name?: unknown }[] }
  const providers = (models.providers ?? []).map((p) => String(p.id ?? ''))
  const defaultModel = resolveDefaultModel()
  console.log(
    JSON.stringify(
      {
        dataDir: getDevaHome(),
        secrets: getSecretsStorageStatus(),
        defaultModel: defaultModel ? `${defaultModel.providerId}:${defaultModel.model}` : null,
        providers,
        bots: listBots().map((b) => ({
          id: b.id,
          platform: b.platform,
          name: b.name,
          enabled: b.enabled,
          pairedUsers: b.users.length
        }))
      },
      null,
      2
    )
  )
  void exitClean(0)
}

// ───────── set-key ─────────

async function cmdSetKey(providerId: string | undefined): Promise<void> {
  if (!providerId) fail('用法：echo "<API Key>" | deva-headless set-key <providerId>')
  const key = await readStdin()
  if (!key) fail('没有读到 API Key（请通过 stdin 传入）。')
  const saved = await setSecret(providerId, key)
  if (!saved.ok) fail('密钥存储不可用，未保存。请设置 DEVA_MASTER_KEY（32 字节 base64）后重试。')
  console.log(`已保存服务商 ${providerId} 的 API Key（加密存储）。`)
  process.exit(0)
}

// ───────── telegram-add ─────────

async function cmdTelegramAdd(): Promise<void> {
  const token = await readStdin()
  if (!/^\d+:[\w-]{20,}$/.test(token)) fail('Token 格式不对，应形如 123456789:AAH…，请从 @BotFather 完整复制。')
  const me = await fetchTelegramMe(token)
  if (listBots().some((b) => b.platform === 'telegram' && b.settings.botId === me.id))
    fail(`@${me.username} 已经添加过了。`)

  const link = await startTelegramLink(token, me)
  console.log(`请用手机扫描下方二维码，或打开链接，在 Telegram 里点击 Start 认领主人（10 分钟内有效）：\n${link.url}\n`)
  console.log(await QRCode.toString(link.url, { type: 'terminal', small: true }))

  const r = await link.outcome
  if (r.kind !== 'done') fail(r.kind === 'error' ? `认领失败：${r.message}` : '认领已过期或已取消，请重新运行。')

  const botId = `bot_${Date.now().toString(36)}_${randomInt(0, 36 ** 4).toString(36)}`
  const saved = await setSecret(`remote:${botId}:botToken`, token)
  if (!saved.ok) fail('密钥存储不可用，无法安全保存机器人 Token。请设置 DEVA_MASTER_KEY 后重试。')
  addBot({
    id: botId,
    platform: 'telegram',
    name: me.first_name || me.username,
    enabled: true,
    createdAt: Date.now(),
    replyMode: 'stream',
    scope: DEFAULT_SCOPE,
    users: [{ id: r.userId, name: r.userName, chatId: '', pairedAt: Date.now() }],
    bindings: {},
    settings: { botId: me.id, username: me.username }
  })
  console.log(`已添加机器人 @${me.username}，主人已认领。运行 serve 后即可在 Telegram 中与它对话。`)
  process.exit(0)
}

// ───────── ask ─────────

// ───────── 分发 ─────────

installNetworkFetch()
const [command = 'serve', ...rest] = process.argv.slice(2)
switch (command) {
  case 'serve':
    cmdServe()
    break
  case 'status':
    cmdStatus()
    break
  case 'set-key':
    void cmdSetKey(rest[0])
    break
  case 'telegram-add':
    void cmdTelegramAdd().catch((e) => fail(`失败：${(e as Error)?.message ?? e}`))
    break
  case 'ask':
    void runAsk(rest).catch((e) => fail(`失败：${(e as Error)?.message ?? e}`))
    break
  case 'job':
    runJob(rest)
    break
  case 'setup':
    void runSetup()
    break
  case 'provider':
    void runProviderCommand(rest).catch((e) => fail(`失败：${(e as Error)?.message ?? e}`))
    break
  case 'remote':
    void runRemoteCommand(rest).catch((e) => fail(`失败：${(e as Error)?.message ?? e}`))
    break
  case 'workspace':
    runWorkspaceCommand(rest)
    break
  case 'secret':
  case 'mcp':
  case 'doctor':
    void runAdminCommand(command, rest).catch((e) => fail(`失败：${(e as Error)?.message ?? e}`))
    break
  default:
    fail(`未知命令：${command}\n可用命令：setup | provider … | remote … | workspace … | secret … | mcp … | ask … | job … | set-key <providerId> | status | serve | telegram-add | ask <文本>`, 2)
}
