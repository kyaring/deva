import DEVA from "./deva-personas"
import XIAOMAJIANG from "./xiaomajiang-personas"

/**
 * 默认角色（首启种子 persona）定义——**各角色及其提示词集中在此、彼此独立**。
 *
 * 每条默认角色是一个自包含的 `DefaultPersona` 常量（含身份、主题色、开场白、提示词等），
 * 由 `DEFAULT_PERSONAS` 数组收拢；`personas.ts` 的 `ensureSeededPersonas()` 首启时逐条种入
 * `~/.deva/personas/<id>.md`（按 id 幂等、防「删除后复活」、支持将来只补种新增的那条）。
 * 之后改了某条的 `prompt`，已安装用户只要没改过该角色的提示词，升级后就会自动换成新版。
 *
 * **新增一个默认角色**：在下方照葫芦画瓢写一个 `const XXX: DefaultPersona`（连同其提示词），
 * 再追加到文末的 `DEFAULT_PERSONAS` 数组即可——无需改动 `personas.ts` 的种入逻辑。
 *
 * 约定：
 * - `id` 稳定不变（文件名 / 启用态键 / 头像确定性种子）；显示名走 `name`，可后续改。
 * - `avatar` 省略（留空）→ 由 id 确定性生成一枚稳定 Humation 头像（用户可在编辑器改）。
 * - `prompt` 只是**附加系统提示词**（性格 / 语气 / 行文风格）；安全与工具铁律恒优先，见 chat.ts。
 */
export interface DefaultPersona {
  /** 文件名（去 .md），稳定身份。 */
  id: string
  /** 显示名。 */
  name: string
  /** 专长，一句话。 */
  description: string
  /** 开场白 / 口头禅。 */
  tagline: string
  /** 首次种入时是否启用（默认角色皆 true，作为可直接对话的身份）。 */
  enabled: boolean
  /** 偏好模型 `"providerId:modelId"`；省略 = 跟随全局默认。 */
  model?: string
  /** 头像 spec（Humation AvatarSpec JSON）；省略 → 由 id 确定性生成。 */
  avatar?: string
  /** 追加进主智能体系统提示词的正文（性格 / 语气 / 行文风格）。 */
  prompt: string
}

/**
 * 全部默认角色（首启逐条种入）。数组顺序 = 首次种入顺序（也是新用户花名册的初始默认排序，
 * 用户之后可拖拽 / 置顶改写，见 personas.ts 的 order 机制）。
 */
export const DEFAULT_PERSONAS: DefaultPersona[] = [DEVA, XIAOMAJIANG]

/**
 * 「提示词跟随新版」上线前各发布版本（v0.1.2–v0.1.9）出现过的默认提示词哈希（算法见 personas.ts `promptHash`）。
 * 那时 config 只记了「已种入」、没记种入的是哪一版，老安装靠这张表判断提示词是否被用户改过。
 * 此后每次种入 / 更新都会在 config 的 `personas.seededPrompt` 记下基线，**以后再改默认提示词无需往这里追加**。
 */
export const LEGACY_PROMPT_HASHES: Record<string, string[]> = {
  general: [
    'd4e72f06a416499e6c8e03ad4e79fe012dd3227b086fdcf313d5f99f0574299c' // v0.1.2–v0.1.9
  ],
  xiaomajiang: [
    '9be2c7d15d58f4022550377011a816cc02faee574c2a6519244cac4589fc8e85', // v0.1.2–v0.1.4
    'd553071fd3e2608d59e0524259a1c15c4b2d747bb6d819309f02266069e14546', // v0.1.5–v0.1.9
  ]
}
