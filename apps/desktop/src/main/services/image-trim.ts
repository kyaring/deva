import type { ContentPart, ImagePart, Message, ToolResultPart } from '../providers/types'
import { lastTurnStart } from './compaction'

/**
 * 发请求前裁剪历史里的工具图片（read_file 读图、MCP 图片块）。不改动历史本身，只产出本次请求用的副本。
 *
 * 为什么要裁：工具循环每一步都把全量历史重发一遍，图片又是 base64 内联，读过的图会在之后每次请求里
 * 一直累积——几十张截图就能把请求体撑到几十 MB，超出服务商 / 中转的上限后只会稳定地失败。
 *
 * 规则（都只针对工具结果里的图片；用户亲手附上的图片 / PDF 没有路径可重读，原样保留）：
 *  - **之前回合**的工具图片一律换成文字说明：模型基于它们得出的结论已在后续回复里，要再看可以重新读。
 *  - **当前回合**的图片原样保留（模型可能正在对比），但超出预算时裁掉较早的：按图片在本回合里的累计
 *    体积 / 张数切成固定的「块」，只留最近 KEEP_CHUNKS 块。块的划分只取决于追加顺序，前面的图不会
 *    因为后面又读了图而改变归属——裁剪边界只在跨进新块时前移一次，其余步骤请求前缀不变，提示缓存照常命中。
 */

/** 每块的 base64 体积上限（字符数）。保留两块 ≈ 16MB，再加上最后一张也远低于官方单次请求 32MB 上限。 */
const CHUNK_CHARS = 8 * 1024 * 1024
/** 每块的张数上限（官方单次请求最多 100 张图，小图很多时靠它兜住）。 */
const CHUNK_COUNT = 20
const KEEP_CHUNKS = 2

function trimmedNote(removed: number, total: number): string {
  return removed === total
    ? '\n（图片已从上下文移除以控制请求体积；需要再看请重新读取该文件或重新调用工具。）'
    : `\n（其中 ${removed} 张图片已从上下文移除以控制请求体积；需要再看请重新读取。）`
}

/** 按 keep 过滤一条工具结果的图片；没变化返回原对象。 */
function trimResult(p: ToolResultPart, keep: (img: ImagePart) => boolean): ToolResultPart {
  const images = p.images ?? []
  const kept = images.filter(keep)
  if (kept.length === images.length) return p
  return {
    ...p,
    content: p.content + trimmedNote(images.length - kept.length, images.length),
    images: kept.length ? kept : undefined
  }
}

export function trimHistoryImages(history: Message[]): Message[] {
  const start = Math.max(0, lastTurnStart(history))

  // 当前回合的工具图片按出现顺序分块，算出要保留的最小块号。
  const chunkOf = new Map<ImagePart, number>()
  let chars = 0
  let count = 0
  let lastChunk = 0
  for (let i = start; i < history.length; i++) {
    const c = history[i].content
    if (typeof c === 'string') continue
    for (const p of c) {
      if (p.type !== 'tool_result' || !p.images) continue
      for (const img of p.images) {
        lastChunk = Math.max(Math.floor(chars / CHUNK_CHARS), Math.floor(count / CHUNK_COUNT))
        chunkOf.set(img, lastChunk)
        chars += img.data.length
        count++
      }
    }
  }
  const minChunk = lastChunk - KEEP_CHUNKS + 1

  let out: Message[] | null = null
  for (let i = 0; i < history.length; i++) {
    const m = history[i]
    if (typeof m.content === 'string') continue
    const old = i < start
    let parts: ContentPart[] | null = null
    m.content.forEach((p, j) => {
      if (p.type !== 'tool_result' || !p.images?.length) return
      const next = trimResult(p, old ? () => false : (img) => (chunkOf.get(img) ?? 0) >= minChunk)
      if (next === p) return
      parts ??= [...(m.content as ContentPart[])]
      parts[j] = next
    })
    if (!parts) continue
    out ??= [...history]
    out[i] = { ...m, content: parts }
  }
  return out ?? history
}
