import { disconnectAllServers } from '../services/mcp'
/**
 * 无头启动流程（serve / 单次命令共用）：按与桌面版相同的顺序注册服务，去掉窗口、托盘、终端与更新器。
 */
import { registerConfigIpc } from '../services/config'
import { registerWorkspaceIpc } from '../services/workspace'
import { registerSecretsIpc } from '../services/secrets'
import { registerProviderIpc } from '../services/provider'
import { registerChatIpc } from '../services/chat'
import { } from '../services/chat-bus'
import { listSessions } from '../services/chat-store'
import { sweepCheckpoints } from '../services/checkpoints'
import { sweepSubagents } from '../services/subagent-store'
import { sweepMedia } from '../services/media-store'
import { registerSkillsIpc, startSkillsWatcher } from '../services/skills'
import { ensureSeededPersonas, registerPersonasIpc } from '../services/personas'
import { registerProfileIpc } from '../services/profile'
import { registerMemoryIpc } from '../services/memory'
import { autoConnectEnabledServers, registerMcpIpc } from '../services/mcp'
import { registerAttachmentsIpc } from '../services/attachments'
import { registerGitIpc } from '../services/git'
import { registerClipboardIpc } from '../services/clipboard'
import { registerDeliverablesIpc } from '../services/deliverables'
import { registerTasksIpc } from '../services/tasks'
import { startScheduler } from '../services/scheduler'
import { registerRemoteIpc } from '../services/remote'
import { } from '../services/remote/telegram'
import { } from '../services/remote/telegram-onboard'
import { } from '../services/remote/hub'

/** 无窗口：服务层各处的 `getWindow()` 都返回 null，走既有的降级分支。 */
const noWindow = (): null => null

type Mode = 'serve' | 'oneshot'

/** 按与桌面版相同的顺序注册服务，去掉窗口、托盘、终端与更新器。 */
export function boot(mode: Mode): void {
  registerConfigIpc()
  registerWorkspaceIpc(noWindow)
  registerSecretsIpc()
  registerProviderIpc()
  registerChatIpc(noWindow)
  // 远程通道：会自动连接已启用的机器人。单发模式（ask）不接入，避免与常驻服务抢同一个 Telegram 轮询。
  if (mode === 'serve') registerRemoteIpc(noWindow)

  void sweepCheckpoints(listSessions().map((m) => m.id)).catch((e) =>
    console.warn('[checkpoints] 清扫失败：', e)
  )
  void sweepSubagents(listSessions().map((m) => m.id)).catch((e) =>
    console.warn('[subagents] 清扫失败：', e)
  )
  void sweepMedia().catch((e) => console.warn('[media] 清扫失败：', e))

  registerSkillsIpc(noWindow)
  startSkillsWatcher(noWindow)
  ensureSeededPersonas()
  registerPersonasIpc()
  registerProfileIpc()
  registerMemoryIpc()
  registerMcpIpc(noWindow)
  registerAttachmentsIpc(noWindow)
  registerGitIpc()
  registerClipboardIpc()
  registerDeliverablesIpc()
  registerTasksIpc(noWindow)
  void autoConnectEnabledServers()
  if (mode === 'serve') startScheduler(noWindow)
}

/**
 * 单次命令退出前先断开 MCP 会话。
 * 启动时会自动连接已启用的 MCP 服务；直接 process.exit 会留下服务端的会话，
 * VPS-Commander 等 Hub 对每个令牌的会话数有上限，累积后会拒绝新连接。
 */
export async function exitClean(code: number): Promise<never> {
  await Promise.race([
    disconnectAllServers().catch(() => undefined),
    new Promise((resolve) => setTimeout(resolve, 5000).unref())
  ])
  process.exit(code)
}
