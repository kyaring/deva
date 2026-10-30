import { useCallback, useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  $isTextNode,
  CLEAR_HISTORY_COMMAND,
  COMMAND_PRIORITY_HIGH,
  HISTORY_MERGE_TAG,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_ENTER_COMMAND,
  KEY_ESCAPE_COMMAND,
  KEY_TAB_COMMAND,
  PASTE_COMMAND,
  DROP_COMMAND,
  RootNode,
  SKIP_DOM_SELECTION_TAG,
  TextNode,
  createEditor,
  mergeRegister,
  type EditorConfig,
  type LexicalCommand,
  type LexicalEditor,
  type LexicalNode
} from 'lexical'
import { registerPlainText } from '@lexical/plain-text'
import { createEmptyHistoryState, registerHistory } from '@lexical/history'
import { $canShowPlaceholder } from '@lexical/text'

/*
 * 对话输入框的编辑器内核（Lexical 纯文本模式，取代原 textarea）。
 * 换成 contentEditable 是为了能给消息开头**会生效**的 `/指令`（已启用技能、整条只有它的 /compact /rewind）
 * 单独上色——textarea 只有一整段纯文本，做不到局部样式。识别规则与主进程 chat.ts sendMessage 一致：
 * 去掉前导空白后以 `/` 开头、取最长的 [A-Za-z0-9_-]+ 作为名字，再由调用方判定是否认得（isToken）。
 * 输入框里始终只有一个段落：纯文本模式下回车 / 粘贴的换行都是段内 LineBreakNode。
 */

/**
 * 被识别为会生效的开头 `/指令`：独立文本节点，只换颜色，仍可照常逐字编辑（不是整块删除的标签）。
 * 紧挨着它键入的字符会先并进它，再由 $syncSlashToken 切回普通文本。
 */
export class SlashTokenNode extends TextNode {
  $config() {
    return this.config('slash-token', { extends: TextNode })
  }

  createDOM(config: EditorConfig): HTMLElement {
    const el = super.createDOM(config)
    el.classList.add('cf-slash-token')
    return el
  }
}

const $isSlashTokenNode = (node: LexicalNode | null | undefined): node is SlashTokenNode =>
  node instanceof SlashTokenNode

/** 开头指令：去掉前导空白后的 `/name`（name 取最长的 [A-Za-z0-9_-]+，同主进程的贪婪匹配）。 */
const LEADING_SLASH_RE = /^(\s*)\/([A-Za-z0-9_-]+)/

/**
 * 用 next 原位替换 node，并把落在 node 上的光标按原偏移挪到 next 上
 * （LexicalNode.replace 默认把光标甩到新节点末尾，打字中途会跳光标）。
 */
function $swapTextNode(node: TextNode, next: TextNode): void {
  const sel = $getSelection()
  const key = node.getKey()
  const keep = $isRangeSelection(sel)
    ? (['anchor', 'focus'] as const).filter((p) => sel[p].key === key).map((p) => [p, sel[p].offset] as const)
    : []
  node.replace(next)
  const after = $getSelection()
  if ($isRangeSelection(after)) for (const [p, offset] of keep) after[p].set(next.getKey(), offset, 'text')
}

/**
 * 让文档里的 SlashTokenNode 与「开头指令」保持一致：位置或文字不对的降回普通文本，
 * 该有却没有的从所在文本节点里切出来换成 SlashTokenNode。每次只改一处后返回——改动会再次弄脏 root，
 * Lexical 先合并相邻普通文本再重跑本变换，直到收敛。
 */
function $syncSlashToken(isToken: (name: string, whole: string) => boolean): void {
  const root = $getRoot()
  const block = root.getFirstChild()
  const leaves = $isElementNode(block) ? block.getChildren() : []
  const m = LEADING_SLASH_RE.exec(leaves.map((n) => n.getTextContent()).join(''))
  const want =
    m && isToken(m[2], root.getTextContent().trim()) ? { start: m[1].length, end: m[0].length } : null

  let offset = 0
  let settled = false
  for (const node of leaves) {
    const size = node.getTextContentSize()
    if ($isSlashTokenNode(node)) {
      if (want && !settled && offset === want.start && offset + size === want.end) settled = true
      else {
        $swapTextNode(node, $createTextNode(node.getTextContent()))
        return
      }
    }
    offset += size
  }
  if (!want || settled) return

  offset = 0
  for (const node of leaves) {
    const size = node.getTextContentSize()
    if (offset + size > want.start) {
      // 区段须整个落在同一个普通文本节点内；横跨多个节点说明合并尚未发生，等下一轮。
      if (!$isTextNode(node) || !node.isSimpleText() || offset + size < want.end) return
      const start = want.start - offset
      const end = want.end - offset
      const parts = start === 0 ? node.splitText(end) : node.splitText(start, end)
      const piece = parts[start === 0 ? 0 : 1]
      if (piece) $swapTextNode(piece, new SlashTokenNode(piece.getTextContent()))
      return
    }
    offset += size
  }
}

/** 输入框交给外层处理的按键（其余按键走 Lexical 纯文本默认行为）。 */
export type ComposerKey = 'enter' | 'up' | 'down' | 'tab' | 'escape'

export interface ComposerEditorHandlers {
  /** 文本变化（含程序写入）；内容未变的更新（如仅移动光标）不触发。 */
  onChange: (text: string) => void
  /** 返回 true = 已处理（须自行 preventDefault），false = 交还编辑器默认行为。 */
  onKey: (key: ComposerKey, e: KeyboardEvent) => boolean
  /** 粘贴：返回 true = 已接管（如粘贴文件转附件），false = 按纯文本粘贴。 */
  onPaste: (e: ClipboardEvent) => boolean
  /** 开头 `/name` 是否会生效（name 为去掉斜杠的原文，whole 为去首尾空白的整条消息）。 */
  isToken: (name: string, whole: string) => boolean
}

export interface ComposerEditor {
  /** 挂到 contentEditable 元素上的 ref 回调。 */
  rootRef: (el: HTMLDivElement | null) => void
  /** 内容为空且不在输入法组字中：外层据此显示占位提示。 */
  empty: boolean
  /** 当前全文（先落定未提交的编辑，发送时用它而不是可能滞后一拍的 React 状态）。 */
  getText: () => string
  /** 整体替换内容，光标置于末尾；focus=true 时顺带聚焦。 */
  setText: (text: string, focus?: boolean) => void
  /** 清空撤销历史（发送后调用，免得撤销把已发出的内容找回来）。 */
  clearHistory: () => void
  /** isToken 的判定依据（技能列表、附件数）变了：重新识别开头指令。 */
  refreshToken: () => void
}

export function useComposerEditor(handlers: ComposerEditorHandlers): ComposerEditor {
  const handlersRef = useRef(handlers)
  handlersRef.current = handlers
  const [editor] = useState<LexicalEditor>(() =>
    createEditor({
      namespace: 'deva-composer',
      nodes: [SlashTokenNode],
      onError: (err) => console.error('[composer]', err)
    })
  )
  const [empty, setEmpty] = useState(true)

  useEffect(() => {
    let lastText = ''
    /** 组字期间跳过了指令识别（改动正在组字的节点会打断输入法），组字结束后补一次。 */
    let skipped = false
    const key = <E extends KeyboardEvent | null>(command: LexicalCommand<E>, name: ComposerKey) =>
      editor.registerCommand(
        command,
        (e: E) => (e === null || e.isComposing ? false : handlersRef.current.onKey(name, e)),
        COMMAND_PRIORITY_HIGH
      )
    // 空文档先放一个段落：根节点下没有块时，首次键入没有可落脚的位置。
    editor.update(
      () => {
        const root = $getRoot()
        if (root.isEmpty()) root.append($createParagraphNode())
      },
      { tag: [HISTORY_MERGE_TAG, SKIP_DOM_SELECTION_TAG] }
    )
    return mergeRegister(
      registerPlainText(editor),
      registerHistory(editor, createEmptyHistoryState(), 300),
      editor.registerNodeTransform(RootNode, () => {
        if (editor.isComposing()) skipped = true
        else $syncSlashToken(handlersRef.current.isToken)
      }),
      editor.registerUpdateListener(({ editorState }) => {
        const [text, blank] = editorState.read(() => [
          $getRoot().getTextContent(),
          $canShowPlaceholder(editor.isComposing())
        ])
        setEmpty(blank)
        if (text !== lastText) {
          lastText = text
          // 同步刷新外层：下一次按键（如紧跟的 Enter）读到的联想 / 发送状态已是最新文本，与受控 textarea 一致。
          flushSync(() => handlersRef.current.onChange(text))
        }
        if (skipped && !editor.isComposing()) {
          skipped = false
          editor.update(() => $getRoot().markDirty(), { tag: HISTORY_MERGE_TAG })
        }
      }),
      key(KEY_ENTER_COMMAND, 'enter'),
      key(KEY_ARROW_UP_COMMAND, 'up'),
      key(KEY_ARROW_DOWN_COMMAND, 'down'),
      key(KEY_TAB_COMMAND, 'tab'),
      key(KEY_ESCAPE_COMMAND, 'escape'),
      editor.registerCommand(
        PASTE_COMMAND,
        (e) => e instanceof ClipboardEvent && handlersRef.current.onPaste(e),
        COMMAND_PRIORITY_HIGH
      ),
      // 拖入文件：不让 Lexical 按文本落入，事件继续冒泡，由外层在窗口级统一转成附件。
      editor.registerCommand(
        DROP_COMMAND,
        (e) => Boolean(e.dataTransfer?.types.includes('Files')),
        COMMAND_PRIORITY_HIGH
      )
    )
  }, [editor])

  const rootRef = useCallback((el: HTMLDivElement | null) => editor.setRootElement(el), [editor])

  const getText = useCallback(() => editor.read(() => $getRoot().getTextContent()), [editor])

  /**
   * 程序改内容：未聚焦时不同步 DOM 选区——Lexical 写 DOM 选区会顺带把焦点抢进输入框。
   * 要聚焦时 editor.focus() 只恢复选区，焦点仍可能留在刚点过的按钮上，故再显式 focus 根元素（同 Lexical AutoFocusPlugin）。
   */
  const update = useCallback(
    (fn: () => void, tags: string[], focus: boolean) => {
      const root = editor.getRootElement()
      const focused = root !== null && root.contains(document.activeElement)
      editor.update(fn, {
        tag: focus || focused ? tags : [...tags, SKIP_DOM_SELECTION_TAG],
        onUpdate: focus
          ? () =>
              editor.focus(() => {
                const el = editor.getRootElement()
                if (el && !el.contains(document.activeElement)) el.focus({ preventScroll: true })
              })
          : undefined
      })
    },
    [editor]
  )

  const setText = useCallback(
    (text: string, focus = false) =>
      update(
        () => {
          const root = $getRoot()
          root.clear()
          const p = $createParagraphNode()
          root.append(p)
          p.select()
          const sel = $getSelection()
          if (text && $isRangeSelection(sel)) sel.insertRawText(text)
        },
        [],
        focus
      ),
    [update]
  )

  const clearHistory = useCallback(
    () => editor.dispatchCommand(CLEAR_HISTORY_COMMAND, undefined),
    [editor]
  )

  const refreshToken = useCallback(
    () => update(() => $getRoot().markDirty(), [HISTORY_MERGE_TAG], false),
    [update]
  )

  return { rootRef, empty, getText, setText, clearHistory, refreshToken }
}
