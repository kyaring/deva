import { Notification, type BrowserWindow } from 'electron'
import { getConfig } from './config'

/**
 * 回复提醒：一轮对话结束、或中途停下来等用户处理时，若用户此刻没在看 Deva，弹一条系统通知；
 * 点击唤起窗口并打开该对话。
 *
 * 「没在看」= 窗口不在焦点上：最小化、关窗驻留托盘、被其它应用盖住都属此类。只看焦点而不看遮挡，
 * 是因为 Electron 只在 macOS 上跟踪窗口遮挡（Windows / Linux 上窗口被完全盖住时页面仍是 visible），
 * 而窗口被别的应用盖住时焦点必然在那个应用上。代价：并排摆着、焦点在别处时也会提醒。
 */

// Windows 上通知对象被回收后点击不再触发回调：持有引用直到点击 / 关闭。
const live = new Set<Notification>()

/** 正文压成一行预览：略去代码块与行首 Markdown 标记，限长。 */
function preview(text: string, max = 120): string {
  const flat = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^\s*(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/\*\*|`/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

function isEn(): boolean {
  return getConfig().locale === 'en'
}

/** 窗口失焦时弹通知（不可用则静默降级）。 */
function show(
  getWindow: () => BrowserWindow | null,
  sessionId: string,
  title: string,
  body: string
): void {
  const current = getWindow()
  if (current && !current.isDestroyed() && current.isFocused()) return
  try {
    if (!Notification.isSupported()) return
    const n = new Notification({ title: title || 'Deva', body })
    live.add(n)
    n.on('close', () => live.delete(n))
    n.on('click', () => {
      live.delete(n)
      const win = getWindow()
      if (!win || win.isDestroyed()) return
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
      // 复用定时任务通知的导航通道：带 sessionId 即打开该对话并切回消息视图。
      win.webContents.send('tasks:navigate', { sessionId })
    })
    n.show()
  } catch {
    /* 通知不可用 / 抛错 → 静默降级 */
  }
}

/**
 * 一轮结束。
 * @param opts.error 有值（可为空串）即按失败提醒；否则正文取回复预览，回复无正文（只调了工具）时给通用文案。
 */
export function notifyReplyDone(
  getWindow: () => BrowserWindow | null,
  opts: { sessionId: string; title: string; text: string; error?: string }
): void {
  const en = isEn()
  let body: string
  if (opts.error !== undefined) {
    const reason = preview(opts.error, 80)
    body = en
      ? `Reply interrupted by an error${reason ? `: ${reason}` : ''}`
      : `回复因错误中断${reason ? `：${reason}` : ''}`
  } else {
    body = preview(opts.text) || (en ? 'Reply completed' : '回复已完成')
  }
  show(getWindow, opts.sessionId, opts.title, body)
}

/** 回合停下来等用户：问答（带首个问题）/ 计划审阅 / 挂载工作区。 */
export type PendingInput =
  | { kind: 'ask'; questions: string[] }
  | { kind: 'plan' }
  | { kind: 'mount' }

export function notifyNeedsInput(
  getWindow: () => BrowserWindow | null,
  opts: { sessionId: string; title: string; input: PendingInput }
): void {
  const en = isEn()
  const { input } = opts
  let body: string
  if (input.kind === 'ask') {
    const first = preview(input.questions[0] ?? '', 80)
    const more = input.questions.length - 1
    const suffix = more > 0 ? (en ? ` (+${more} more)` : `（另有 ${more} 个问题）`) : ''
    body = first
      ? `${en ? 'Needs your answer: ' : '需要你回答：'}${first}${suffix}`
      : en
        ? 'Needs your answer'
        : '需要你回答问题'
  } else if (input.kind === 'plan') {
    body = en ? 'A plan is ready for your review' : '计划已拟好，等待你审阅'
  } else {
    body = en
      ? 'A workspace folder must be mounted to continue'
      : '需要挂载工作区文件夹才能继续'
  }
  show(getWindow, opts.sessionId, opts.title, body)
}
