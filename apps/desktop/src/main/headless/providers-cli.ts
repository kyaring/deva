/**
 * 无头版配置命令：服务商、模型、默认模型，以及交互式向导 `setup`。
 * 数据与桌面版同构：config.json 的 models 段 + 加密保存的 API Key，两边可以直接互通。
 * 注意：修改配置后需重启 serve（常驻进程持有配置的内存副本，否则可能被旧副本覆盖）。
 */
import { createInterface } from 'node:readline'
import { getConfig, registerConfigIpc, setConfig } from '../services/config'
import { hasSecret, registerSecretsIpc, setSecret } from '../services/secrets'
import { registerProviderIpc } from '../services/provider'
import { seedProviders, type Provider, type ProviderAdapter } from '../../shared/providers'
import { invokeIpc } from './electron-shim'

interface Models {
  providers: Provider[]
  activeModelId: string | null
  [key: string]: unknown
}

interface ListModelsResult {
  ok: boolean
  models?: string[]
  message?: string
}

const ADAPTERS: { value: ProviderAdapter; label: string }[] = [
  { value: 'openai', label: 'OpenAI Chat Completions（兼容绝大多数服务，推荐）' },
  { value: 'anthropic', label: 'Anthropic Messages' },
  { value: 'responses', label: 'OpenAI Responses' }
]

function die(message: string, code = 1): never {
  console.error(message)
  process.exit(code)
}

function bootConfigOnly(): void {
  registerConfigIpc()
  registerSecretsIpc()
  registerProviderIpc()
}

function readModels(): Models {
  const m = (getConfig().models ?? {}) as Partial<Models>
  return {
    ...m,
    providers: Array.isArray(m.providers) ? (m.providers as Provider[]) : [],
    activeModelId: typeof m.activeModelId === 'string' ? m.activeModelId : null
  }
}

function writeModels(m: Models): void {
  setConfig({ models: m })
}

function findProvider(models: Models, id: string): Provider | undefined {
  return models.providers.find((p) => p.id === id)
}

function requireProvider(models: Models, id: string | undefined): Provider {
  if (!id) die('请指定服务商 ID。')
  const p = findProvider(models, id)
  if (!p) die(`找不到服务商 ${id}（用 provider list 查看，或 provider add 添加）。`)
  return p
}

function parseFlags(args: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = []
  const flags: Record<string, string> = {}
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a.startsWith('--')) {
      flags[a.slice(2)] = args[i + 1] ?? ''
      i++
    } else positional.push(a)
  }
  return { positional, flags }
}

function ensureModel(list: Provider['models'], id: string): Provider['models'] {
  const existing = list.find((m) => m.id === id)
  if (existing) return list.map((m) => (m.id === id ? { ...m, enabled: true } : m))
  return [...list, { id, name: id, enabled: true }]
}

async function fetchModels(p: Provider): Promise<ListModelsResult> {
  return (await invokeIpc('provider:list-models', {
    adapter: p.adapter,
    providerId: p.id,
    baseURL: p.apiHost
  })) as ListModelsResult
}

// ───────── provider 子命令 ─────────

async function cmdList(): Promise<void> {
  const models = readModels()
  if (models.providers.length === 0) {
    console.log('尚未配置服务商。运行 `setup` 进行配置。')
    return
  }
  for (const p of models.providers) {
    const keyed = await hasSecret(p.id)
    const active = models.activeModelId?.startsWith(`${p.id}:`) ? '*' : ' '
    console.log(
      `${active} ${p.id}  ${p.name}  [${p.adapter}] ${p.apiHost}  ${p.enabled ? '启用' : '停用'}  Key:${keyed ? '已设置' : '未设置'}`
    )
    for (const m of p.models) console.log(`      - ${m.id}${m.enabled ? '' : '（停用）'}`)
  }
  console.log(`\n默认模型：${models.activeModelId ?? '未设置'}（带 * 的为默认模型所在的服务商）`)
}

function cmdAdd(id: string | undefined, flags: Record<string, string>): void {
  if (!id) die('用法：provider add <id> [--adapter openai|anthropic|responses] [--host <地址>] [--name <名称>]')
  const models = readModels()
  if (findProvider(models, id)) die(`服务商 ${id} 已存在。`)

  const preset = seedProviders.find((p) => p.kind === 'official' && p.id === id)
  if (preset && !flags.host && !flags.adapter) {
    writeModels({ ...models, providers: [...models.providers, { ...preset, enabled: true, models: [] }] })
    console.log(`已添加官方服务商 ${preset.name}。接下来：set-key ${id}，然后 provider models ${id}。`)
    return
  }

  const adapter = (flags.adapter ?? 'openai') as ProviderAdapter
  if (!ADAPTERS.some((a) => a.value === adapter)) die(`不支持的协议：${adapter}`)
  const host = flags.host ?? ''
  if (!/^https?:\/\//.test(host)) die('请用 --host 指定以 http(s):// 开头的 API 地址。')
  writeModels({
    ...models,
    providers: [
      ...models.providers,
      {
        id,
        name: flags.name ?? id,
        kind: 'custom',
        accent: '#64748b',
        adapter,
        apiHost: host,
        enabled: true,
        models: []
      }
    ]
  })
  console.log(`已添加服务商 ${id}（${adapter} · ${host}）。`)
}

async function cmdRemove(id: string | undefined): Promise<void> {
  if (!id) die('用法：provider remove <id>')
  const models = readModels()
  requireProvider(models, id)
  await setSecret(id, '') // 空串 = 删除密钥
  const activeWasHere = models.activeModelId?.startsWith(`${id}:`) ?? false
  writeModels({
    ...models,
    providers: models.providers.filter((p) => p.id !== id),
    activeModelId: activeWasHere ? null : models.activeModelId
  })
  console.log(`已删除服务商 ${id}（包括其 API Key）。${activeWasHere ? '默认模型已清空，请重新 use。' : ''}`)
}

async function cmdModels(id: string | undefined): Promise<void> {
  const p = requireProvider(readModels(), id)
  if (!(await hasSecret(p.id))) die(`尚未设置 ${p.id} 的 API Key，请先 set-key。`)
  const r = await fetchModels(p)
  if (!r.ok) die(`拉取模型清单失败：${r.message ?? '未知错误'}`)
  for (const m of r.models ?? []) console.log(m)
}

async function cmdModelAdd(pid: string | undefined, mid: string | undefined): Promise<void> {
  if (!pid || !mid) die('用法：provider model add <providerId> <modelId>  或  provider model add <providerId> --all')
  if (mid === '--all') {
    const p0 = requireProvider(readModels(), pid)
    if (!(await hasSecret(pid))) die(`尚未设置 ${pid} 的 API Key，无法拉取模型清单（先 set-key）。`)
    const r = await fetchModels(p0)
    if (!r.ok) die(`拉取模型清单失败：${r.message ?? '未知错误'}`)
    const latest = readModels()
    let list = latest.providers.find((x) => x.id === pid)?.models ?? []
    for (const id of r.models ?? []) list = ensureModel(list, id)
    writeModels({ ...latest, providers: latest.providers.map((x) => (x.id === pid ? { ...x, models: list } : x)) })
    console.log(`已添加 ${pid} 的 ${r.models?.length ?? 0} 个模型。用 provider list 查看，provider use ${pid}:<模型ID> 设为默认。`)
    return
  }
  const models = readModels()
  const p = requireProvider(models, pid)
  const next = { ...p, models: ensureModel(p.models, mid) }
  writeModels({ ...models, providers: models.providers.map((x) => (x.id === pid ? next : x)) })
  console.log(`已添加模型 ${pid}:${mid}。用 provider use ${pid}:${mid} 设为默认。`)
}

function cmdModelRemove(pid: string | undefined, mid: string | undefined): void {
  if (!pid || !mid) die('用法：provider model remove <providerId> <modelId>')
  const models = readModels()
  const p = requireProvider(models, pid)
  const ref = `${pid}:${mid}`
  writeModels({
    ...models,
    providers: models.providers.map((x) => (x.id === pid ? { ...p, models: p.models.filter((m) => m.id !== mid) } : x)),
    activeModelId: models.activeModelId === ref ? null : models.activeModelId
  })
  console.log(`已删除模型 ${ref}。`)
}

function cmdUse(ref: string | undefined): void {
  if (!ref || !ref.includes(':')) die('用法：provider use <providerId>:<modelId>')
  const [pid, ...rest] = ref.split(':')
  const mid = rest.join(':')
  const models = readModels()
  const p = requireProvider(models, pid)
  if (!p.models.some((m) => m.id === mid)) die(`服务商 ${pid} 下没有模型 ${mid}（先用 provider model add 添加）。`)
  writeModels({ ...models, activeModelId: ref })
  console.log(`默认模型已设为 ${ref}。`)
}

// ───────── setup 向导 ─────────

function createAsker(): { ask: (q: string, hidden?: boolean) => Promise<string>; close: () => void } {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
  let muted = false
  const rlAny = rl as unknown as { _writeToOutput: (s: string) => void }
  const writeOrig = rlAny._writeToOutput.bind(rl)
  rlAny._writeToOutput = (s: string) => {
    if (!muted) writeOrig(s)
  }
  return {
    ask: (q, hidden = false) =>
      new Promise((resolve) => {
        muted = false
        rl.question(q, (ans) => {
          muted = false
          resolve(ans.trim())
        })
        muted = hidden // 提示已写出；此后的输入回显被屏蔽
      }),
    close: () => rl.close()
  }
}

async function cmdSetup(): Promise<void> {
  if (!process.stdin.isTTY) die('setup 需要在交互式终端中运行。脚本或远程批量场景请使用 provider / set-key 子命令。')
  bootConfigOnly()
  const { ask, close } = createAsker()
  try {
    console.log('Deva 无头版配置向导（Ctrl+C 退出）\n')
    const officials = seedProviders.filter((p) => p.kind === 'official' && p.adapter !== 'jev')
    officials.forEach((p, i) => console.log(`  ${i + 1}. ${p.name}  (${p.id})`))
    const customIdx = officials.length + 1
    console.log(`  ${customIdx}. 自定义（OpenAI 兼容等）\n`)

    const choice = Number((await ask(`选择服务商 [1]: `)) || '1')
    if (!Number.isInteger(choice) || choice < 1 || choice > customIdx) die('无效的选择。')

    const models = readModels()
    let provider: Provider
    if (choice === customIdx) {
      const id = await ask('服务商 ID（英文，如 myproxy）: ')
      if (!/^[a-z0-9][a-z0-9-]*$/i.test(id)) die('ID 只能包含字母、数字和横线。')
      if (findProvider(models, id)) die(`服务商 ${id} 已存在，请直接用 provider 命令管理。`)
      const name = (await ask(`显示名称 [${id}]: `)) || id
      ADAPTERS.forEach((a, i) => console.log(`  ${i + 1}. ${a.label}`))
      const ai = Number((await ask('协议 [1]: ')) || '1')
      const adapter = ADAPTERS[ai - 1]?.value
      if (!adapter) die('无效的协议选择。')
      const host = await ask('API 地址（Base URL，如 https://example.com/v1）: ')
      if (!/^https?:\/\//.test(host)) die('API 地址必须以 http(s):// 开头。')
      provider = { id, name, kind: 'custom', accent: '#64748b', adapter, apiHost: host, enabled: true, models: [] }
    } else {
      const preset = officials[choice - 1]
      provider = findProvider(models, preset.id) ?? { ...preset, enabled: true, models: [] }
    }

    // API Key：输入时不回显，保存前经主进程加密
    if (await hasSecret(provider.id)) {
      const replace = await ask(`${provider.name} 已保存过 API Key，是否替换？(y/N): `)
      if (replace.toLowerCase() === 'y') {
        const key = await ask('新的 API Key（输入时不显示）: ', true)
        if (!key) die('未输入 API Key。')
        if (!(await setSecret(provider.id, key)).ok) die('密钥存储不可用，请设置 DEVA_MASTER_KEY 后重试。')
      }
    } else {
      const key = await ask(`${provider.name} 的 API Key（输入时不显示）: `, true)
      if (!key) die('未输入 API Key。')
      if (!(await setSecret(provider.id, key)).ok) die('密钥存储不可用，请设置 DEVA_MASTER_KEY 后重试。')
    }
    console.log('\nAPI Key 已加密保存。正在获取模型清单…')

    let modelId: string | undefined
    const r = await fetchModels(provider)
    if (r.ok && r.models && r.models.length > 0) {
      const list = r.models.slice(0, 40)
      list.forEach((m, i) => console.log(`  ${i + 1}. ${m}`))
      if (r.models.length > list.length) console.log(`  …共 ${r.models.length} 个，可直接输入模型 ID`)
      const pick = await ask('\n选择模型（编号或直接输入模型 ID）: ')
      const idx = Number(pick)
      modelId = Number.isInteger(idx) && idx >= 1 && idx <= list.length ? list[idx - 1] : pick
    } else {
      console.log(`无法自动获取模型清单${r.message ? `（${r.message}）` : ''}。`)
      modelId = await ask('请输入模型 ID: ')
    }
    if (!modelId) die('未选择模型。')

    const latest = readModels()
    const updated: Provider = { ...provider, enabled: true, models: ensureModel(provider.models, modelId) }
    const exists = latest.providers.some((p) => p.id === provider.id)
    writeModels({
      ...latest,
      providers: exists
        ? latest.providers.map((p) => (p.id === provider.id ? updated : p))
        : [...latest.providers, updated],
      activeModelId: `${provider.id}:${modelId}`
    })
    console.log(`\n完成：默认模型为 ${provider.id}:${modelId}。`)
    console.log('若服务正在运行，请重启服务使配置生效（systemctl restart deva-headless）。')
  } finally {
    close()
  }
  process.exit(0)
}

// ───────── 分发 ─────────

export async function runProviderCommand(args: string[]): Promise<void> {
  bootConfigOnly()
  const [sub, ...rest0] = args
  // --all 是开关（无值），先单独取出，避免被当成带值的选项
  const all = rest0.includes('--all')
  const rest = rest0.filter((a) => a !== '--all')
  const { positional, flags } = parseFlags(rest)
  switch (sub) {
    case 'list':
      await cmdList()
      break
    case 'add':
      cmdAdd(positional[0], flags)
      break
    case 'remove':
      await cmdRemove(positional[0])
      break
    case 'models':
      await cmdModels(positional[0])
      break
    case 'model': {
      const [action, pid, mid] = positional
      if (action === 'add') await cmdModelAdd(pid, all ? '--all' : mid)
      else if (action === 'remove') cmdModelRemove(pid, mid)
      else die('用法：provider model add|remove <providerId> <modelId>')
      break
    }
    case 'use':
      cmdUse(positional[0])
      break
    default:
      die(
        '用法：provider list | add <id> [--adapter …] [--host …] [--name …] | remove <id> | models <id> | model add|remove <id> <modelId> | use <id>:<modelId>',
        2
      )
  }
  process.exit(0)
}

export { cmdSetup as runSetup }
