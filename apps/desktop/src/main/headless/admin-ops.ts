/**
 * 管理操作的统一实现（密钥、MCP 服务）。
 * 同一套函数有两个调用方：
 *  - serve 运行中：由控制接口（control.ts）在服务进程内执行，服务持有状态，不会被旧副本覆盖；
 *  - serve 未运行：由 CLI 直接在本进程执行（此时没有进程会覆盖文件）。
 */
import { deleteServer, getServerConfig, setEnabled, upsertServer, type McpServerInput } from '../services/mcp-config'
import { autoConnectEnabledServers, listServers, registerMcpIpc, type McpServerView } from '../services/mcp'
import { listSecretNames, setSecret } from '../services/secrets'

export type OpResult = { ok: true; data?: unknown } | { ok: false; error: string }

const TERMINAL: McpServerView['status'][] = ['connected', 'error', 'needs_config', 'needs_secret']

function summarize(v: McpServerView) {
  return {
    id: v.id,
    name: v.name,
    transport: v.transport,
    url: v.url ?? null,
    enabled: v.enabled,
    status: v.status,
    toolCount: v.toolCount,
    lastError: v.lastError,
    missingSecrets: v.missingSecrets
  }
}

/**
 * 测试一个 MCP 服务：走与服务运行时完全相同的连接路径，等待到终态后返回结果。
 * 测试会临时启用该服务；测试结束后恢复原来的启用状态。
 */
async function testMcp(id: string): Promise<unknown> {
  if (!getServerConfig(id)) throw new Error(`MCP 服务 ${id} 不存在`)
  const wasEnabled = listServers().find((s) => s.id === id)?.enabled ?? false
  if (!wasEnabled) setEnabled(id, true)
  autoConnectEnabledServers()
  const deadline = Date.now() + 45_000
  let view: McpServerView | undefined
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500))
    view = listServers().find((s) => s.id === id)
    if (view && TERMINAL.includes(view.status)) break
  }
  if (!wasEnabled) setEnabled(id, false)
  if (!view) throw new Error('未能获取连接状态')
  return {
    ...summarize(view),
    timedOut: !TERMINAL.includes(view.status),
    tools: view.tools.map((t) => t.name)
  }
}

export async function executeOp(op: string, params: Record<string, unknown>): Promise<OpResult> {
  try {
    switch (op) {
      case 'secret-list':
        return { ok: true, data: await listSecretNames() }
      case 'secret-set': {
        const r = await setSecret(String(params.key), String(params.value))
        return r.ok ? { ok: true } : { ok: false, error: '密钥存储不可用，请设置 DEVA_MASTER_KEY 后重试。' }
      }
      case 'secret-delete':
        await setSecret(String(params.key), '') // 空串 = 删除
        return { ok: true }
      case 'mcp-list':
        return { ok: true, data: listServers().map(summarize) }
      case 'mcp-upsert': {
        const cfg = upsertServer(params.input as McpServerInput)
        return { ok: true, data: { id: cfg.id } }
      }
      case 'mcp-remove':
        deleteServer(String(params.id))
        return { ok: true }
      case 'mcp-enable':
        setEnabled(String(params.id), Boolean(params.enabled))
        return { ok: true }
      case 'mcp-test':
        return { ok: true, data: await testMcp(String(params.id)) }
      default:
        return { ok: false, error: `未知操作：${op}` }
    }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

/** CLI 直接执行时需要先登记 MCP 的监听（与 serve 的启动路径一致，去掉窗口）。 */
export function bootAdminOps(): void {
  registerMcpIpc(() => null)
}
