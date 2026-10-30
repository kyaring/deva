/**
 * 模型配置的读写（服务层）：服务商下的模型、默认模型、单个会话的模型。
 * 数据格式与 CLI（provider 命令）相同，都保存在 config.json 的 models 段与会话文件里。
 * 供 Telegram 的 /models、/model 指令使用；服务进程持有配置，这里的修改直接生效。
 */
import { getConfig, setConfig } from './config'
import { getSecret } from './secrets'
import { listProviderModels } from './provider'
import { getSession, save as saveSession } from './chat-store'
import { resolveDefaultModel, resolveModelRefOrNull } from './model-resolve'
import type { Provider } from '../../shared/providers'

interface ModelsCfg {
  providers: Provider[]
  activeModelId: string | null
  [key: string]: unknown
}

function read(): ModelsCfg {
  const m = ((getConfig() as { models?: Partial<ModelsCfg> }).models ?? {}) as Partial<ModelsCfg>
  return {
    ...m,
    providers: Array.isArray(m.providers) ? (m.providers as Provider[]) : [],
    activeModelId: typeof m.activeModelId === 'string' ? m.activeModelId : null
  }
}

function write(m: ModelsCfg): void {
  setConfig({ models: m })
}

function requireProvider(cfg: ModelsCfg, pid: string): Provider {
  const p = cfg.providers.find((x) => x.id === pid)
  if (!p) throw new Error(`找不到服务商 ${pid}（用 /models 查看）`)
  return p
}

/** 添加模型；已存在则确保为启用状态。 */
export function addModel(pid: string, mid: string): void {
  if (!/^[\w.:/\-]+$/.test(mid)) throw new Error('模型 ID 格式不对')
  const cfg = read()
  const p = requireProvider(cfg, pid)
  const models = p.models.some((m) => m.id === mid)
    ? p.models.map((m) => (m.id === mid ? { ...m, enabled: true } : m))
    : [...p.models, { id: mid, name: mid, enabled: true }]
  write({ ...cfg, providers: cfg.providers.map((x) => (x.id === pid ? { ...x, models } : x)) })
}

/** 拉取服务商的全部模型并加入配置，返回数量。 */
export async function addAllModels(pid: string): Promise<number> {
  const p = requireProvider(read(), pid)
  if (!(await getSecret(pid))) throw new Error(`尚未设置 ${pid} 的 API Key，无法拉取模型清单`)
  const r = await listProviderModels({ adapter: p.adapter, providerId: p.id, baseURL: p.apiHost } as never)
  if (!r.ok) throw new Error(r.message ?? '拉取模型清单失败')
  for (const id of r.models ?? []) addModel(pid, id)
  return r.models?.length ?? 0
}

/** 删除模型。默认模型不能直接删除，需先换默认模型。 */
export function removeModel(pid: string, mid: string): void {
  const cfg = read()
  requireProvider(cfg, pid)
  if (cfg.activeModelId === `${pid}:${mid}`) throw new Error('这是默认模型，请先用 /model default 换一个默认模型')
  write({
    ...cfg,
    providers: cfg.providers.map((x) => (x.id === pid ? { ...x, models: x.models.filter((m) => m.id !== mid) } : x))
  })
}

export function setDefaultModel(ref: string): void {
  write({ ...read(), activeModelId: ref })
}

/** 指定会话的模型（undefined = 跟随默认模型）。与 chat:set-model 相同的落库方式。 */
export function setSessionModel(sid: string, ref: string | undefined): void {
  const s = getSession(sid)
  if (!s) return
  s.model = ref
  saveSession(sid)
}

/** 模型总览：标出默认模型（★）与本对话正在用的模型（▶）。 */
export function modelsOverview(sid: string | null): string {
  const cfg = read()
  const sess = sid ? getSession(sid) : undefined
  const effective = resolveModelRefOrNull(sess?.model) ?? resolveDefaultModel()
  const effRef = effective ? `${effective.providerId}:${effective.model}` : null
  const lines: string[] = []
  for (const p of cfg.providers) {
    if (!p.enabled) continue
    lines.push(`【${p.name}】${p.id}`)
    if (p.models.length === 0) lines.push(`  （暂无模型，用 /model add ${p.id} 模型ID 添加）`)
    for (const m of p.models) {
      const ref = `${p.id}:${m.id}`
      const marks = [ref === cfg.activeModelId ? '★默认' : '', ref === effRef ? '▶本对话' : ''].filter(Boolean)
      lines.push(`  ${ref}${marks.length ? `  ${marks.join(' ')}` : ''}`)
    }
  }
  const how = sess?.model ? '已指定' : '跟随默认'
  return [
    `本对话模型：${effRef ?? '未配置'}（${how}）`,
    ...lines,
    '',
    '切换本对话：/model 服务商:模型',
    '设为默认：/model default 服务商:模型',
    '恢复跟随默认：/model reset'
  ].join('\n')
}
