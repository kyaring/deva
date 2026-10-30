/**
 * 极简零依赖 frontmatter 解析（够用即可，不引 YAML 库以守免装铁律 + 减攻击面）。
 * 仅识别文件开头的 `---` 块，支持四类条目：
 *   key: 标量            → string（去引号）
 *   key: [a, b, c]       → string[]（内联数组）
 *   key:                 → string[]（其后若干 `- item` 缩进列表项）
 *   key:                 → Record<string, string>（其后若干缩进的 `k: v`，一层映射，如标准 SKILL.md 的 metadata）
 * 其余复杂 YAML 语法一律不支持——SKILL.md / agent.md 的 frontmatter 只需上述四型。
 * body 为 `---` 结束行之后的全部原文（保留换行，仅去掉紧随其后的一个空行）。
 */

export type FmValue = string | string[] | Record<string, string>

export interface ParsedFrontmatter {
  data: Record<string, FmValue>
  body: string
}

function stripQuotes(v: string): string {
  const s = v.trim()
  if (s.length >= 2 && s[0] === '"' && s.endsWith('"')) {
    // 双引号：反转义 \\ 与 \"（与 fmScalar 的转义对称，保证往返一致）
    return s.slice(1, -1).replace(/\\(["\\])/g, '$1')
  }
  if (s.length >= 2 && s[0] === "'" && s.endsWith("'")) {
    return s.slice(1, -1)
  }
  return s
}

function parseInlineArray(v: string): string[] {
  // 去掉外层 [ ]，按逗号分隔，逐项去引号；空项丢弃。
  const inner = v.trim().replace(/^\[/, '').replace(/\]$/, '')
  return inner
    .split(',')
    .map((x) => stripQuotes(x))
    .filter((x) => x.length > 0)
}

/**
 * 解析 frontmatter。无有效 `---` 头部时 data 为空、body 为原文（容错，绝不抛错）。
 */
export function parseFrontmatter(raw: string): ParsedFrontmatter {
  const text = raw.replace(/^﻿/, '') // 去 BOM
  // 必须以 `---`（可含尾随空白）单独成行开头
  const lines = text.split(/\r?\n/)
  if (lines[0]?.trim() !== '---') return { data: {}, body: text }

  // 找到结束的 `---`
  let end = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      end = i
      break
    }
  }
  if (end === -1) return { data: {}, body: text } // 没有闭合 → 视作无 frontmatter

  const data: Record<string, FmValue> = {}
  let i = 1
  while (i < end) {
    const line = lines[i]
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) {
      i++
      continue
    }
    const m = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line)
    if (!m) {
      i++
      continue
    }
    const key = m[1]
    const rest = m[2].trim()
    if (rest.startsWith('[') && rest.endsWith(']')) {
      data[key] = parseInlineArray(rest)
      i++
    } else if (rest === '') {
      // 其后若干 `- item` 缩进列表项，或若干缩进的 `k: v`（一层映射）
      const items: string[] = []
      const map: Record<string, string> = {}
      let j = i + 1
      while (j < end) {
        const lm = /^\s*-\s+(.*)$/.exec(lines[j])
        if (lm) {
          const val = stripQuotes(lm[1])
          if (val) items.push(val)
          j++
          continue
        }
        const km = /^\s+([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(lines[j])
        if (!km) break
        map[km[1]] = stripQuotes(km[2])
        j++
      }
      data[key] = items.length === 0 && Object.keys(map).length > 0 ? map : items
      i = j
    } else {
      data[key] = stripQuotes(rest)
      i++
    }
  }

  // body：结束行之后，去掉紧随的一个空行
  let bodyStart = end + 1
  if (lines[bodyStart] !== undefined && lines[bodyStart].trim() === '') bodyStart++
  const body = lines.slice(bodyStart).join('\n')
  return { data, body }
}

/** 取标量字段（数组则取首项）；缺失或为映射返回 ''。 */
export function fmString(data: Record<string, FmValue>, key: string): string {
  const v = data[key]
  if (typeof v === 'string') return v
  if (Array.isArray(v)) return v[0] ?? ''
  return ''
}

/**
 * 取字符串数组字段；缺失或为映射返回 []。标量按逗号或空白拆分：标准 SKILL.md 的 allowed-tools
 * 是空格分隔串（`Bash(git:*) Read`），也常见逗号分隔。括号内的空白与逗号不拆（`Bash(git add:*)`）。
 */
export function fmArray(data: Record<string, FmValue>, key: string): string[] {
  const v = data[key]
  if (Array.isArray(v)) return v
  if (typeof v !== 'string') return []
  const out: string[] = []
  let cur = ''
  let depth = 0
  for (const ch of v) {
    if (ch === '(') depth++
    else if (ch === ')') depth = Math.max(0, depth - 1)
    if (depth === 0 && (ch === ',' || /\s/.test(ch))) {
      if (cur.trim()) out.push(cur.trim())
      cur = ''
    } else {
      cur += ch
    }
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

/** 取一层映射字段（如标准 SKILL.md 的 metadata）；缺失或非映射返回 {}。 */
export function fmMap(data: Record<string, FmValue>, key: string): Record<string, string> {
  const v = data[key]
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
}

/** 把值序列化为 frontmatter 行的标量表示（含特殊字符时加双引号并转义）。 */
export function fmScalar(v: string): string {
  if (v === '') return '""'
  if (/[:#\[\]{}"'\n]/.test(v) || /^\s|\s$/.test(v)) {
    return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  }
  return v
}
