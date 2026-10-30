/**
 * 无头版的密钥与 MCP 管理命令：
 *   secret list | set <键名>（stdin 读值）| delete <键名>
 *   mcp list | add <id> … | remove <id> | enable <id> | disable <id> | test <id>
 *
 * 服务运行中：经控制接口交由 serve 执行；未运行：CLI 直接执行。两者调用同一套函数（admin-ops.ts）。
 * 安全约束：密钥值只从 stdin 读入（不进命令行参数）；敏感请求头不允许写明文，必须用 @secret 引用。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { getConfig, getDevaHome, registerConfigIpc } from '../services/config'
import { getSecret, getSecretsStorageStatus, hasSecret, registerSecretsIpc } from '../services/secrets'
import { listSecretNames } from '../services/secrets'
import { registerProviderIpc } from '../services/provider'
import { resolveDefaultModel } from '../services/model-resolve'
import { listBots } from '../services/remote/store'
import { fetchTelegramMe } from '../services/remote/telegram'
import { invokeIpc } from './electron-shim'
import { controlRequest } from './control'
import { bootAdminOps, executeOp, type OpResult } from './admin-ops'
import { exitClean } from './boot'

function die(message: string, code = 1): never {
  console.error(message)
  process.exit(code)
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8').trim()
}

async function run(op: string, params: Record<string, unknown>): Promise<OpResult> {
  const r = await controlRequest(join(getDevaHome(), 'control.sock'), { cmd: 'op', args: { op, params } })
  if (r) return r
  registerConfigIpc()
  registerSecretsIpc()
  bootAdminOps()
  return executeOp(op, params)
}

function unwrap<T = unknown>(r: OpResult): T {
  if (!r.ok) die(r.error)
  return r.data as T
}

// ───────── 参数解析 ─────────

interface Parsed {
  positional: string[]
  flags: Record<string, string>
  multi: Record<string, string[]>
  switches: Set<string>
}

const MULTI = new Set(['header', 'env', 'arg'])
const SWITCHES = new Set(['enable'])

function parse(args: string[]): Parsed {
  const out: Parsed = { positional: [], flags: {}, multi: {}, switches: new Set() }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (!a.startsWith('--')) {
      out.positional.push(a)
      continue
    }
    const key = a.slice(2)
    if (SWITCHES.has(key)) {
      out.switches.add(key)
      continue
    }
    const value = args[++i] ?? ''
    if (MULTI.has(key)) (out.multi[key] ??= []).push(value)
    else out.flags[key] = value
  }
  return out
}

/** K=V 或 K=@secret（引用加密库中的 mcp:<id>:K）；K=@secret:NAME 指定引用名。 */
const SENSITIVE = /auth|token|key|secret|cookie|passw|credential/i

function kv(raw: string, serverId: string, what: 'header' | 'env'): [string, string | { secretRef: string }] {
  const eq = raw.indexOf('=')
  if (eq <= 0) die(`--${what} 格式应为 名称=值，收到：${raw}`)
  const name = raw.slice(0, eq).trim()
  const value = raw.slice(eq + 1)
  if (value === '@secret') return [name, { secretRef: name }]
  if (value.startsWith('@secret:')) return [name, { secretRef: value.slice('@secret:'.length) }]
  if (SENSITIVE.test(name)) {
    die(`${name} 看起来是敏感信息，不能写明文。请改用 ${name}=@secret，再执行：echo '…' | deva-headless secret set mcp:${serverId}:${name}`)
  }
  return [name, value]
}

// ───────── secret ─────────

async function cmdSecret(args: string[]): Promise<void> {
  const p = parse(args)
  const [sub, name] = p.positional
  switch (sub) {
    case 'list': {
      const names = unwrap<string[]>(await run('secret-list', {}))
      if (names.length === 0) console.log('（暂无密钥）')
      for (const n of names) console.log(n)
      return
    }
    case 'set': {
      if (!name) die('用法：echo "<值>" | deva-headless secret set <键名>')
      const value = await readStdin()
      if (!value) die('没有读到内容（请通过 stdin 传入，不要放在命令行参数里）。')
      unwrap(await run('secret-set', { key: name, value }))
      console.log(`已加密保存：${name}`)
      return
    }
    case 'delete': {
      if (!name) die('用法：deva-headless secret delete <键名>')
      unwrap(await run('secret-delete', { key: name }))
      console.log(`已删除：${name}`)
      return
    }
    default:
      die('用法：secret list | set <键名> | delete <键名>', 2)
  }
}

// ───────── mcp ─────────

interface McpView {
  id: string
  name: string
  transport: string
  url: string | null
  enabled: boolean
  status: string
  toolCount: number
  lastError: string | null
  missingSecrets: string[]
}

function printMissing(view: { id: string; missingSecrets: string[] }): void {
  for (const s of view.missingSecrets) {
    console.log(`  缺少密钥：${s}  →  echo "<值>" | deva-headless secret set mcp:${view.id}:${s}`)
  }
}

async function cmdMcp(args: string[]): Promise<void> {
  const p = parse(args)
  const [sub, id] = p.positional
  switch (sub) {
    case 'list': {
      const list = unwrap<McpView[]>(await run('mcp-list', {}))
      if (list.length === 0) console.log('（暂无 MCP 服务）')
      for (const v of list) {
        console.log(`${v.id}  ${v.name}  [${v.transport}] ${v.url ?? ''}  ${v.enabled ? '启用' : '停用'}  状态:${v.status}  工具:${v.toolCount}`)
        if (v.lastError) console.log(`    错误：${v.lastError}`)
        printMissing(v)
      }
      return
    }
    case 'add': {
      if (!id) die('用法：deva-headless mcp add <id> --transport http|sse|stdio --url <地址> [--header 名=值|名=@secret] [--name 名称] [--enable]')
      const transport = p.flags.transport ?? 'http'
      if (!['http', 'sse', 'stdio'].includes(transport)) die(`不支持的传输方式：${transport}`)
      const headers = Object.fromEntries((p.multi.header ?? []).map((h) => kv(h, id, 'header')))
      const env = Object.fromEntries((p.multi.env ?? []).map((e) => kv(e, id, 'env')))
      const input = {
        id,
        name: p.flags.name ?? id,
        transport,
        url: p.flags.url,
        command: p.flags.command,
        args: p.multi.arg ?? [],
        headers,
        env,
        enabled: p.switches.has('enable')
      }
      const r = unwrap<{ id: string }>(await run('mcp-upsert', { input }))
      console.log(`已保存 MCP 服务 ${r.id}（${p.switches.has('enable') ? '已启用' : '未启用，用 mcp enable 启用'}）。`)
      const refs = [
        ...Object.entries(headers).filter(([, v]) => typeof v !== 'string').map(([k]) => k),
        ...Object.entries(env).filter(([, v]) => typeof v !== 'string').map(([k]) => k)
      ]
      for (const k of refs) console.log(`  需要密钥：mcp:${id}:${k}  →  echo "<值>" | deva-headless secret set mcp:${id}:${k}`)
      console.log(`验证：deva-headless mcp test ${id}`)
      return
    }
    case 'remove': {
      if (!id) die('用法：deva-headless mcp remove <id>')
      unwrap(await run('mcp-remove', { id }))
      console.log(`已删除 MCP 服务 ${id}（包括它的密钥）。`)
      return
    }
    case 'enable':
    case 'disable': {
      if (!id) die(`用法：deva-headless mcp ${sub} <id>`)
      unwrap(await run('mcp-enable', { id, enabled: sub === 'enable' }))
      console.log(`${id} 已${sub === 'enable' ? '启用' : '停用'}。`)
      return
    }
    case 'test': {
      if (!id) die('用法：deva-headless mcp test <id>')
      const v = unwrap<McpView & { tools: string[]; timedOut: boolean }>(await run('mcp-test', { id }))
      const ok = v.status === 'connected'
      console.log(`${ok ? '✓' : '✗'} ${v.id}  状态：${v.status}${v.timedOut ? '（超时）' : ''}  工具数：${v.toolCount}`)
      if (v.tools.length) console.log(`  工具：${v.tools.slice(0, 20).join(', ')}${v.tools.length > 20 ? ' …' : ''}`)
      if (v.lastError) console.log(`  错误：${v.lastError}`)
      printMissing(v)
      await exitClean(ok ? 0 : 1)
    }
    default:
      die('用法：mcp list | add <id> … | remove <id> | enable <id> | disable <id> | test <id>', 2)
  }
}

// ───────── doctor：逐项验证整套配置是否真正可用（不输出任何密钥值） ─────────

async function cmdDoctor(): Promise<void> {
  let bad = 0
  const check = (ok: boolean, msg: string): void => {
    if (!ok) bad++
    console.log(`${ok ? '✓' : '✗'} ${msg}`)
  }

  registerConfigIpc()
  registerSecretsIpc()
  registerProviderIpc()

  // 1. 服务与密钥存储
  const running = (await controlRequest(join(getDevaHome(), 'control.sock'), { cmd: 'bots' })) !== null
  check(running, running ? '服务运行中（控制接口可用）' : '服务未运行（改动将直接写入文件，生效需重启服务）')
  const st = getSecretsStorageStatus()
  check(st.available, `密钥存储：${st.backend ?? '-'}${st.available ? '' : `（不可用：${st.reason}）`}`)

  // 2. 每个密钥都能解密（只报告结果，不输出值）
  for (const name of await listSecretNames()) {
    check((await getSecret(name)) !== null, `密钥可解密：${name}`)
  }

  // 3. MCP 服务：走与运行时相同的连接路径
  const servers = unwrap<McpView[]>(await run('mcp-list', {}))
  if (servers.length === 0) console.log('- 未配置 MCP 服务')
  for (const s of servers) {
    if (!s.enabled) {
      console.log(`- MCP ${s.id}：未启用，跳过`)
      continue
    }
    const t = unwrap<McpView & { tools: string[] }>(await run('mcp-test', { id: s.id }))
    check(t.status === 'connected', `MCP ${s.id}：${t.status}，工具 ${t.toolCount} 个${t.lastError ? `（${t.lastError}）` : ''}`)
  }

  // 4. Telegram 机器人：Token 能通过 getMe 校验
  for (const b of listBots()) {
    if (b.platform !== 'telegram') continue
    const token = await getSecret(`remote:${b.id}:botToken`)
    if (!token) {
      check(false, `机器人 ${b.name}：缺少 Token`)
      continue
    }
    try {
      const me = await fetchTelegramMe(token)
      check(true, `机器人 @${me.username}：Token 有效，已配对 ${b.users.length} 人`)
    } catch (e) {
      check(false, `机器人 ${b.name}：Token 校验失败（${(e as Error).message}）`)
    }
  }

  // 5. 默认模型：配置、密钥与服务可达性
  const model = resolveDefaultModel()
  check(model !== null, model ? `默认模型：${model.providerId}:${model.model}` : '未设置默认模型（运行 deva-headless setup）')
  if (model) {
    check(await hasSecret(model.providerId), `模型服务 ${model.providerId}：API Key 已设置`)
    const r = (await invokeIpc('provider:list-models', {
      adapter: model.adapter,
      providerId: model.providerId,
      baseURL: model.baseURL
    })) as { ok: boolean; message?: string }
    check(r.ok, r.ok ? `模型服务 ${model.providerId}：可访问` : `模型服务 ${model.providerId}：不可访问（${r.message ?? ''}）`)
  }

  // 6. 工作区
  const ws = (getConfig() as { imDefaultWorkspace?: unknown }).imDefaultWorkspace
  if (typeof ws === 'string' && ws) check(existsSync(ws), `默认工作区存在：${ws}`)

  console.log(bad === 0 ? '\n全部通过。' : `\n${bad} 项未通过，见上。`)
  await exitClean(bad === 0 ? 0 : 1)
}

export async function runAdminCommand(command: 'secret' | 'mcp' | 'doctor', args: string[]): Promise<void> {
  if (command === 'secret') await cmdSecret(args)
  else if (command === 'mcp') await cmdMcp(args)
  else await cmdDoctor()
  await exitClean(0)
}
