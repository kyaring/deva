/**
 * serve 进程的本地控制接口（Unix socket，权限 0600，只接受本机进程）。
 *
 * 为什么需要它：配对邀请码只存在于运行中的 serve 进程内存里（见 services/remote/hub.ts），
 * 其它进程无法生成或校验；配对用户列表也由 serve 持有内存副本，直接改文件会被它覆盖。
 * 所以 CLI 的 `remote` 子命令通过这个接口与 serve 通信；serve 未运行时由 CLI 兜底处理。
 *
 * 协议：每个连接发送一行 JSON 请求 `{cmd, args}`，收到一行 JSON 响应后关闭。
 */
import { chmodSync, existsSync, unlinkSync } from 'node:fs'
import net from 'node:net'
import { cancelPairCode, issuePairCode, removePairedUser } from '../services/remote/hub'
import { executeOp } from './admin-ops'
import { getBot, listBots } from '../services/remote/store'

export interface ControlRequest {
  cmd: string
  args?: Record<string, unknown>
}

export type ControlResponse = { ok: true; data?: unknown } | { ok: false; error: string }

async function handle(req: ControlRequest): Promise<ControlResponse> {
  const botId = String(req.args?.botId ?? '')
  switch (req.cmd) {
    case 'op': {
      // 密钥与 MCP 等管理操作：统一交给 admin-ops 执行（在本进程内，状态由服务持有）
      const r = await executeOp(String(req.args?.op ?? ''), (req.args?.params as Record<string, unknown>) ?? {})
      return r
    }
    case 'pair-code': {
      if (!getBot(botId)) return { ok: false, error: '机器人不存在。' }
      return { ok: true, data: issuePairCode(botId) }
    }
    case 'pair-cancel': {
      if (!getBot(botId)) return { ok: false, error: '机器人不存在。' }
      cancelPairCode(botId)
      return { ok: true }
    }
    case 'remove-user': {
      const userId = String(req.args?.userId ?? '')
      const bot = getBot(botId)
      if (!bot) return { ok: false, error: '机器人不存在。' }
      if (!bot.users.some((u) => u.id === userId)) return { ok: false, error: '该用户不在配对列表中。' }
      removePairedUser(botId, userId)
      return { ok: true }
    }
    case 'bots':
      return { ok: true, data: listBots().map((b) => ({ id: b.id, name: b.name, users: b.users.length })) }
    default:
      return { ok: false, error: `未知命令：${req.cmd}` }
  }
}

/** 启动控制接口；返回清理函数（关闭服务并删除 socket 文件）。 */
export function startControlServer(path: string): () => void {
  if (existsSync(path)) unlinkSync(path) // 上次异常退出留下的残留文件
  const server = net.createServer((sock) => {
    let buf = ''
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8')
      const nl = buf.indexOf('\n')
      if (nl < 0) return
      const line = buf.slice(0, nl)
      buf = ''
      void (async () => {
        let res: ControlResponse
        try {
          res = await handle(JSON.parse(line) as ControlRequest)
        } catch {
          res = { ok: false, error: '请求格式错误。' }
        }
        sock.end(JSON.stringify(res) + '\n')
      })()
    })
    sock.on('error', () => {
      /* 客户端断开：忽略 */
    })
  })
  server.listen(path, () => {
    try {
      chmodSync(path, 0o600)
    } catch {
      /* 忽略：权限无法设置时仍由目录权限保护 */
    }
  })
  server.on('error', (e) => console.warn('[control] 控制接口启动失败：', e))
  return () => {
    server.close()
    try {
      if (existsSync(path)) unlinkSync(path)
    } catch {
      /* 已删除 */
    }
  }
}

/** CLI 侧调用：返回 null 表示 serve 未运行（连接失败或超时）。 */
export function controlRequest(path: string, req: ControlRequest): Promise<ControlResponse | null> {
  return new Promise((resolve) => {
    if (!existsSync(path)) {
      resolve(null)
      return
    }
    const sock = net.createConnection(path)
    let data = ''
    const timer = setTimeout(() => {
      sock.destroy()
      resolve(null)
    }, 5000)
    sock.on('connect', () => sock.write(JSON.stringify(req) + '\n'))
    sock.on('data', (chunk) => (data += chunk.toString('utf8')))
    sock.on('end', () => {
      clearTimeout(timer)
      try {
        resolve(JSON.parse(data) as ControlResponse)
      } catch {
        resolve(null)
      }
    })
    sock.on('error', () => {
      clearTimeout(timer)
      resolve(null)
    })
  })
}
