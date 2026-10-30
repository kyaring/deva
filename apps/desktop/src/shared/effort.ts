/**
 * 思考等级（effort）与模型能力内置表——主进程（决定发什么）与渲染层（决定显示哪几档）共用的纯函数模块，
 * 不依赖 Node / DOM。
 *
 * 不是所有模型都有全部档位：表按模型 ID 列出「支持哪几档、每档发给服务商的值、开思考用哪套参数」，
 * 选择器只显示支持的档，发送前把对话里存的档位就近收敛到支持的档（见 clampEffort）。数据参照 pi-ai 的
 * 内置模型目录（DeepSeek Harness 所用；其规则：无思考能力 → 只有「关」；xhigh / max 须显式标注才算支持）。
 *
 * 参数格式（ThinkFormat）：
 *  - standard：Anthropic adaptive thinking + output_config.effort（Claude 原生）/ OpenAI reasoning_effort /
 *    Responses reasoning.effort；
 *  - deepseek / zai / qwen：国产家族在 OpenAI Chat 协议上开思考要各自的私有开关（thinking.type /
 *    enable_thinking），能调档的再附 reasoning_effort。格式先按服务地址判定（同一模型放在百炼上就得用通义的
 *    开关），认不出再按模型家族；
 *  - compat：国产模型走 Anthropic 兼容端点——各家都认 output_config.effort、大多默认开着思考，却未必认 Claude
 *    专属的 adaptive，故只发 effort；只能开不能调的发 thinking.type=enabled，默认不思考的另附 thinking.type=adaptive。
 *  Responses 协议不分家族，一律按 standard 发 reasoning.effort：国产厂商少有该端点，走它的多是中转站，
 *  由中转站换算成上游格式（同 pi-ai）；只能开不能调的发 high 表示开启。
 */

/** 'default' = 不发任何思考 / 推理参数，交给模型与服务商的默认行为。 */
export type EffortLevel = 'default' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
/** 实际调档的五档（不含 'default'），由低到高。 */
export type ThinkLevel = Exclude<EffortLevel, 'default'>
/** 对话模型的协议适配器（与 providers/* 一致）。 */
export type EffortAdapter = 'anthropic' | 'openai' | 'responses'
/** 开思考 / 调档所用的参数格式，见文件头。 */
export type ThinkFormat = 'standard' | 'deepseek' | 'zai' | 'qwen' | 'compat'

export const THINK_LEVELS: readonly ThinkLevel[] = ['low', 'medium', 'high', 'xhigh', 'max']

export function isEffortLevel(v: unknown): v is EffortLevel {
  return v === 'default' || (THINK_LEVELS as readonly unknown[]).includes(v)
}

/** 档位 → 发给服务商的值；表里没有的档 = 该模型不支持（选择器不显示）。 */
type LevelMap = Partial<Record<ThinkLevel, string>>

const LMH: LevelMap = { low: 'low', medium: 'medium', high: 'high' }
const LMHX: LevelMap = { ...LMH, xhigh: 'xhigh' }
const LMH_MAX: LevelMap = { ...LMH, max: 'max' }
const FULL: LevelMap = { ...LMHX, max: 'max' }
const H_MAX: LevelMap = { high: 'high', max: 'max' }
const L_H_MAX: LevelMap = { low: 'low', high: 'high', max: 'max' }

interface Rule {
  match: RegExp
  /** 支持的档；null = 不支持思考等级（选择器整个隐藏、恒按「默认」发）。toggle 规则可省略。 */
  levels?: LevelMap | null
  /** 该家族在 OpenAI Chat 协议上开思考的参数格式（缺省 standard）。 */
  format?: ThinkFormat
  /** 只能开、不能调档：只发开思考的开关、不发档位值，选择器显示「默认 / 开启」。 */
  toggle?: boolean
  /** 开着思考时，回放的助手消息须带 reasoning_content 字段（DeepSeek 思考模式的硬要求，缺了即 400）。 */
  reasoningField?: boolean
  /**
   * 国产模型走 Anthropic 协议时按 compat 格式发：'effort' = 只发 output_config.effort；'adaptive' = 该模型默认
   * 不思考，另发 thinking.type=adaptive 打开。私有格式家族不必标，缺省即 'effort'。
   */
  compat?: 'effort' | 'adaptive'
  /** 只在这些协议上核实过；其余协议跳过本条、接着往下匹配。 */
  adapters?: EffortAdapter[]
}

/**
 * 规则按顺序匹配（小写模型 ID，不锚定首尾——中转常加前缀 `anthropic/`、后缀 `-20251001`），首条命中即用。
 */
const RULES: Rule[] = [
  // ── Anthropic：adaptive thinking + output_config.effort（4.6 起）。4.5 及更早只认 budget_tokens，未接。
  { match: /claude-(fable|mythos)/, levels: FULL },
  { match: /claude-(opus|sonnet)-4[-.]6/, levels: LMH_MAX },
  { match: /claude-(opus|sonnet|haiku)-(4[-.][7-9]|[5-9])/, levels: FULL },
  { match: /claude/, levels: null },
  // ── OpenAI：reasoning_effort（Chat）/ reasoning.effort（Responses）。chat / pro 变体先于通用规则。
  { match: /gpt-5\.2-chat/, levels: { medium: 'medium', xhigh: 'xhigh' } },
  { match: /gpt-5(\.\d+)?-chat/, levels: null },
  { match: /gpt-5-pro/, levels: { high: 'high' } },
  { match: /gpt-5\.\d+-pro/, levels: { medium: 'medium', high: 'high', xhigh: 'xhigh' } },
  { match: /gpt-5\.1-codex-max/, levels: LMHX },
  { match: /gpt-(5\.([6-9]|\d{2,})|[6-9])/, levels: FULL },
  { match: /gpt-5\.[2-5]/, levels: LMHX },
  { match: /gpt-5/, levels: LMH },
  { match: /gpt-oss/, levels: LMH },
  { match: /(^|[^a-z0-9])o1-mini/, levels: null },
  { match: /(^|[^a-z0-9])o[134](-|$)/, levels: LMH },
  { match: /gpt-(4|3\.5)|chatgpt/, levels: null },
  // ── xAI
  { match: /grok-4\.([6-9]|\d{2,})/, levels: LMHX },
  { match: /grok-4\.[3-5]/, levels: LMH },
  { match: /grok-3-mini/, levels: { low: 'low', high: 'high' } },
  { match: /grok/, levels: null },
  // ── Google（OpenAI 兼容端点认 reasoning_effort）
  { match: /gemma-4/, levels: { high: 'high' } },
  { match: /gemini/, levels: LMH },
  // ── DeepSeek：thinking.type 开思考 + reasoning_effort 调档。reasoner / r1 恒在思考、无从调。
  { match: /deepseek-(v4\.1-flash|flash)/, levels: L_H_MAX, format: 'deepseek', reasoningField: true },
  { match: /deepseek-v4/, levels: H_MAX, format: 'deepseek', reasoningField: true },
  { match: /deepseek-(chat|v3\.[2-9])/, toggle: true, format: 'deepseek', reasoningField: true },
  { match: /deepseek/, levels: null },
  // ── 智谱 GLM：thinking.type 开思考；5.2 起可附 reasoning_effort 调档。glm-4 早期型号无思考。
  { match: /glm-5\.([3-9]|\d{2,})/, levels: L_H_MAX, format: 'zai' },
  { match: /glm-5-turbo/, toggle: true, format: 'zai' },
  { match: /glm-5/, levels: H_MAX, format: 'zai' },
  { match: /glm-4\.[5-9]/, toggle: true, format: 'zai' },
  { match: /glm/, levels: null },
  // ── 通义：enable_thinking 开思考；3.8 起可附 reasoning_effort 调档。qwq 恒在思考。
  { match: /qwen3\.([8-9]|\d{2,})/, levels: { low: 'low', medium: 'medium', xhigh: 'xhigh' }, format: 'qwen' },
  { match: /qwq/, levels: null },
  { match: /qwen/, toggle: true, format: 'qwen' },
  // ── Moonshot：kimi-k3 走标准 reasoning_effort（Anthropic 端点不认 thinking 参数）；k2 系用 thinking.type 开思考、不能调档。
  { match: /kimi-k3/, levels: L_H_MAX, reasoningField: true, compat: 'effort' },
  { match: /kimi-k2/, toggle: true, format: 'deepseek' },
  // ── MiniMax：只核实了 Anthropic 端点（官方推荐接法），OpenAI Chat 的开关未核实；M3 默认不思考，须 adaptive 打开。
  { match: /minimax-m([3-9]|\d{2,})/, adapters: ['anthropic', 'responses'], levels: FULL, compat: 'adaptive' },
  // ── 豆包（火山方舟）：只核实了 Anthropic 端点，output_config.effort 各档都收（不支持的由服务端映射）。
  { match: /doubao-seed-([2-9]|\d{2,})/, adapters: ['anthropic', 'responses'], levels: FULL, compat: 'effort' },
  // ── 其余国产：参数各异、尚未核实，暂不支持
  { match: /kimi|moonshot|minimax|doubao|ernie|hunyuan|baichuan/, levels: null }
]

/** 表里查不到的模型（自定义 / 中转改名）：给最通用的低 / 中 / 高三档，不认时由引擎自愈回落「默认」。 */
const FALLBACK: Rule = { match: /^/, levels: LMH }

/** 只能开不能调的模型，内部用一档 high 表示「开启」，不带档位值。 */
const TOGGLE_MAP: LevelMap = { high: '' }
/** 同上，走 Responses 协议时：标准协议没有开关字段，发 reasoning.effort=high 表示开启。 */
const TOGGLE_MAP_RESPONSES: LevelMap = { high: 'high' }

function findRule(adapter: EffortAdapter, modelId: string): Rule {
  const id = modelId.toLowerCase()
  return RULES.find((r) => (!r.adapters || r.adapters.includes(adapter)) && r.match.test(id)) ?? FALLBACK
}

/** 按服务地址判定私有格式（官方端点）；认不出返回 undefined，交由模型家族决定。 */
function endpointFormat(baseURL: string | undefined): ThinkFormat | undefined {
  if (!baseURL) return undefined
  let host = ''
  try {
    host = new URL(baseURL).hostname.toLowerCase()
  } catch {
    return undefined
  }
  if (host === 'deepseek.com' || host.endsWith('.deepseek.com')) return 'deepseek'
  if (host.endsWith('bigmodel.cn') || host === 'z.ai' || host.endsWith('.z.ai')) return 'zai'
  if (host.includes('dashscope')) return 'qwen'
  return undefined
}

interface Resolved {
  map: LevelMap
  format: ThinkFormat
  toggle: boolean
  reasoningField: boolean
  /** compat 格式另发的 thinking.type（见 EffortRequest.thinking）。 */
  thinking?: 'enabled' | 'adaptive'
}

/** 规则 + 协议 + 服务地址 → 实际能力；null = 不支持思考等级。 */
function resolve(adapter: EffortAdapter, modelId: string, baseURL?: string): Resolved | null {
  const rule = findRule(adapter, modelId)
  const map = rule.toggle ? TOGGLE_MAP : rule.levels
  if (!map) return null
  const family = rule.format ?? 'standard'
  const toggle = Boolean(rule.toggle)
  if (adapter === 'anthropic') {
    // 国产模型的 Anthropic 兼容端点用 compat；Claude 及表外模型用 Claude 原生写法。
    const compat = rule.compat ?? (family === 'standard' ? undefined : 'effort')
    if (!compat) return { map, format: 'standard', toggle: false, reasoningField: false }
    const thinking = toggle ? 'enabled' : compat === 'adaptive' ? 'adaptive' : undefined
    return { map, format: 'compat', toggle, reasoningField: false, ...(thinking ? { thinking } : {}) }
  }
  // Responses 是标准协议，不分家族一律发 reasoning.effort（见文件头）。
  if (adapter === 'responses')
    return { map: toggle ? TOGGLE_MAP_RESPONSES : map, format: 'standard', toggle, reasoningField: false }
  return {
    map,
    format: endpointFormat(baseURL) ?? family,
    toggle,
    reasoningField: Boolean(rule.reasoningField)
  }
}

/** 该模型支持的档位（由低到高）；空数组 = 不支持思考等级。只能开不能调的模型返回 ['high']。 */
export function supportedEffortLevels(adapter: EffortAdapter, modelId: string): ThinkLevel[] {
  const r = resolve(adapter, modelId)
  return r ? THINK_LEVELS.filter((l) => r.map[l] !== undefined) : []
}

/** 是否「只能开、不能调档」：选择器把唯一的一档显示为「开启」。 */
export function isToggleEffort(adapter: EffortAdapter, modelId: string): boolean {
  return resolve(adapter, modelId)?.toggle ?? false
}

/**
 * 把存下的档位收敛到该模型支持的档：'default' 原样；支持即原样；否则先往低找最近的（省钱、不擅自加码），
 * 低处没有再往高找；模型不支持思考等级 → 'default'。对话里存的仍是用户原选（换回支持的模型即恢复）。
 */
export function clampEffort(adapter: EffortAdapter, modelId: string, level: EffortLevel): EffortLevel {
  if (level === 'default') return 'default'
  const supported = supportedEffortLevels(adapter, modelId)
  if (supported.includes(level)) return level
  const idx = THINK_LEVELS.indexOf(level)
  for (let i = idx - 1; i >= 0; i--) if (supported.includes(THINK_LEVELS[i])) return THINK_LEVELS[i]
  for (let i = idx + 1; i < THINK_LEVELS.length; i++)
    if (supported.includes(THINK_LEVELS[i])) return THINK_LEVELS[i]
  return 'default'
}

/** 一次请求要带的思考参数（适配器据 format 拼成各家字段）。 */
export interface EffortRequest {
  format: ThinkFormat
  /** 档位值（reasoning_effort / output_config.effort）；缺省 = 只开思考、不调档。standard 格式必有。 */
  effort?: string
  /** 回放的助手消息补 reasoning_content 字段（见 Rule.reasoningField）。 */
  reasoningField?: boolean
  /** compat 格式另发的 thinking.type：只能开不能调的发 'enabled'，默认不思考的发 'adaptive'；缺省 = 不发 thinking。 */
  thinking?: 'enabled' | 'adaptive'
}

/** 某档（须已收敛）对应的请求参数；'default' / 不支持 → undefined（不发任何思考参数）。 */
export function effortRequest(
  adapter: EffortAdapter,
  modelId: string,
  baseURL: string | undefined,
  level: EffortLevel
): EffortRequest | undefined {
  if (level === 'default') return undefined
  const r = resolve(adapter, modelId, baseURL)
  const value = r?.map[level]
  if (!r || value === undefined) return undefined
  return {
    format: r.format,
    ...(value ? { effort: value } : {}),
    ...(r.reasoningField ? { reasoningField: true } : {}),
    ...(r.thinking ? { thinking: r.thinking } : {})
  }
}
