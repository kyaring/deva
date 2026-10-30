/**
 * 无头版的对话与后台作业：
 *   ask [--session <id>] [--timeout <秒>] <文本…>   前台：流式输出；结束后打印会话 ID，可用 --session 续接
 *   ask --background [--session <id>] <文本…>       后台：立即返回作业 ID，输出写入 jobs/<id>.out
 *   job list | status <id> | log <id> [行数] | cancel <id>
 *
 * 作业状态以文件保存在 DEVA_HOME/jobs/ 下：<id>.json（元数据）、<id>.out / <id>.err（输出）。
 * 同一会话同一时间只允许一个回合，后台作业与前台命令共用这条规则。
 */
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getDevaHome } from '../services/config'
import { getChatRuntime } from '../services/chat'
import { onChatEvent } from '../services/chat-bus'
import { ensureSession, getSession, save as saveSession } from '../services/chat-store'
import { resolveDefaultEffort, resolveDefaultModel, resolveModelRefOrNull } from '../services/model-resolve'
import { defaultImWorkspace } from '../services/remote/hub'
import { boot, exitClean } from './boot'

type Outcome = 'done' | 'error' | 'cancelled' | 'timeout'
type JobStatus = 'running' | Outcome | 'lost'

interface Job {
  id: string
  status: JobStatus
  pid: number | null
  sessionId: string
  prompt: string
  createdAt: number
  finishedAt?: number
  exitCode?: number
  out: string
  err: string
}

function die(message: string, code = 1): never {
  console.error(message)
  process.exit(code)
}

const SESSION_ID = /^[A-Za-z0-9_-]{1,64}$/

// ───────── 作业存储 ─────────

function jobsDir(): string {
  const dir = join(getDevaHome(), 'jobs')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}

function jobFile(id: string): string {
  return join(jobsDir(), `${id}.json`)
}

function writeJob(job: Job): void {
  const tmp = `${jobFile(job.id)}.tmp`
  writeFileSync(tmp, JSON.stringify(job, null, 2), { mode: 0o600 })
  renameSync(tmp, jobFile(job.id))
}

function readJob(id: string): Job | null {
  try {
    return JSON.parse(readFileSync(jobFile(id), 'utf8')) as Job
  } catch {
    return null
  }
}

function updateJob(id: string, patch: Partial<Job>): void {
  const job = readJob(id)
  if (job) writeJob({ ...job, ...patch })
}

function listJobs(): Job[] {
  return readdirSync(jobsDir())
    .filter((f) => f.endsWith('.json'))
    .map((f) => readJob(f.slice(0, -5)))
    .filter((j): j is Job => j !== null)
    .sort((a, b) => b.createdAt - a.createdAt)
}

function isAlive(pid: number | null): boolean {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** 进程已不在、但记录仍为 running 的作业视为 lost（例如被强杀）。 */
function effective(job: Job): JobStatus {
  return job.status === 'running' && !isAlive(job.pid) ? 'lost' : job.status
}

function runningJobFor(sessionId: string): Job | undefined {
  return listJobs().find((j) => j.sessionId === sessionId && effective(j) === 'running')
}

// ───────── 单个回合 ─────────

async function runTurn(sessionId: string, text: string, timeoutSec: number | null, pinModel: string | null): Promise<Outcome> {
  if (pinModel && !resolveModelRefOrNull(pinModel)) {
    process.stderr.write(`找不到模型 ${pinModel}（用 provider list 查看，或 provider model add 添加）。\n`)
    return 'error'
  }
  const existing = getSession(sessionId)
  // 新对话挂载默认工作区；续接的对话保留原有挂载
  const focusRoot = existing ? (existing.focusRoot ?? null) : defaultImWorkspace()
  if (!existing) {
    // 新对话不写死模型：未指定时跟随全局默认模型（provider use 切换后立即生效）
    ensureSession(sessionId, { focusRoot, effort: resolveDefaultEffort(), model: pinModel ?? undefined })
  } else if (pinModel) {
    existing.model = pinModel
    saveSession(sessionId)
  }
  const session = getSession(sessionId)
  const model = resolveModelRefOrNull(session?.model) ?? resolveDefaultModel()
  if (!model) {
    process.stderr.write('尚未配置默认模型：请先运行 deva-headless setup。\n')
    return 'error'
  }
  process.stderr.write(`[模型] ${model.providerId}:${model.model}\n`)
  const rt = getChatRuntime()
  if (!rt) {
    process.stderr.write('聊天服务未就绪。\n')
    return 'error'
  }

  let turnId: string | null = null
  let cancelled = false
  let timedOut = false
  let settle!: (o: Outcome) => void
  const finished = new Promise<Outcome>((resolve) => (settle = resolve))

  const abort = (): void => {
    cancelled = true
    if (turnId) rt.abort(turnId)
    // 兜底：若回合迟迟不结束，8 秒后直接收尾
    setTimeout(() => settle('cancelled'), 8000).unref()
  }
  process.once('SIGTERM', abort)
  process.once('SIGINT', abort)
  const timer = timeoutSec
    ? setTimeout(() => {
        timedOut = true
        if (turnId) rt.abort(turnId)
      }, timeoutSec * 1000)
    : null

  onChatEvent((p) => {
    if (!turnId || p.turnId !== turnId) return
    const ev = p.event
    switch (ev.type) {
      case 'text_delta':
        process.stdout.write(ev.text)
        break
      case 'tool_call':
        process.stderr.write(`\n[工具] ${ev.name}\n`)
        break
      case 'error':
        process.stderr.write(`\n[错误] ${ev.message}\n`)
        settle('error')
        break
      case 'done':
        settle(cancelled ? 'cancelled' : timedOut ? 'timeout' : 'done')
        break
      default:
        break
    }
  })

  try {
    const r = await rt.send({
      sessionId,
      text,
      model: { adapter: model.adapter, providerId: model.providerId, baseURL: model.baseURL, model: model.model },
      workspaceRoot: null,
      focusRoot,
      modelRef: `${model.providerId}:${model.model}`,
      effort: resolveDefaultEffort()
    })
    turnId = r.turnId
  } catch (e) {
    process.stderr.write(`发送失败：${(e as Error)?.message ?? e}\n`)
    return 'error'
  }
  const outcome = await finished
  if (timer) clearTimeout(timer)
  return outcome
}

// ───────── ask ─────────

interface AskFlags {
  session?: string
  timeout?: number
  model?: string
  background: boolean
}

function parseAsk(args: string[]): { flags: AskFlags; text: string } {
  const flags: AskFlags = { background: false }
  const words: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--session') flags.session = args[++i]
    else if (a === '--timeout') flags.timeout = Number(args[++i])
    else if (a === '--model') flags.model = args[++i]
    else if (a === '--background') flags.background = true
    else words.push(a)
  }
  return { flags, text: words.join(' ').trim() }
}

function isCompiledBun(): boolean {
  const bun = (globalThis as { Bun?: { main?: string } }).Bun
  return typeof bun?.main === 'string' && bun.main.startsWith('/$bunfs')
}

async function startBackground(sid: string, text: string, flags: AskFlags): Promise<never> {
  const id = `job-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`
  const out = join(jobsDir(), `${id}.out`)
  const err = join(jobsDir(), `${id}.err`)
  writeJob({ id, status: 'running', pid: null, sessionId: sid, prompt: text.slice(0, 200), createdAt: Date.now(), out, err })

  const outFd = openSync(out, 'a')
  const errFd = openSync(err, 'a')
  // 编译后的 bun 二进制：argv[1] 是虚拟路径（/$bunfs/…），子进程直接用二进制本身启动；
  // Node 运行 .cjs 时仍需要把脚本路径作为第一个参数。
  const head = isCompiledBun() ? [] : [process.argv[1]]
  const args = [...head, 'ask', '--session', sid]
  if (flags.timeout) args.push('--timeout', String(flags.timeout))
  if (flags.model) args.push('--model', flags.model)
  args.push(text)
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: ['ignore', outFd, errFd],
    env: { ...process.env, DEVA_JOB_ID: id }
  })
  child.unref()
  closeSync(outFd)
  closeSync(errFd)
  updateJob(id, { pid: child.pid ?? null })

  console.log(`已提交后台作业 ${id}（会话 ${sid}）`)
  console.log(`进度：deva-headless job status ${id}    输出：job log ${id}    取消：job cancel ${id}`)
  return exitClean(0)
}

export async function runAsk(args: string[]): Promise<void> {
  const { flags, text } = parseAsk(args)
  if (!text) die('用法：deva-headless ask [--session <id>] [--background] [--timeout <秒>] <文本>')
  const sid = flags.session ?? randomUUID()
  if (!SESSION_ID.test(sid)) die('会话 ID 只能包含字母、数字、横线和下划线（最长 64 位）。')

  const jobId = process.env.DEVA_JOB_ID // 后台作业的子进程会带上它
  if (!jobId) {
    const busy = runningJobFor(sid)
    if (busy) die(`会话 ${sid} 有后台作业正在运行（${busy.id}），请等待完成或 job cancel 后再继续。`)
  }

  if (flags.background && !jobId) {
    boot('oneshot')
    await startBackground(sid, text, flags)
  }

  boot('oneshot')
  process.stderr.write(`[会话] ${sid}\n`)
  const outcome = await runTurn(sid, text, flags.timeout ?? null, flags.model ?? null)
  process.stdout.write('\n')
  process.stderr.write(`[会话] ${sid}（续接：ask --session ${sid} "…"）\n`)
  if (jobId) updateJob(jobId, { status: outcome, finishedAt: Date.now(), exitCode: outcome === 'done' ? 0 : 1 })
  void exitClean(outcome === 'done' ? 0 : 1)
}

// ───────── job ─────────

function tail(file: string, n: number): string[] {
  if (!existsSync(file)) return []
  const lines = readFileSync(file, 'utf8').split('\n')
  return lines.slice(-n).filter((l, i, arr) => !(i === arr.length - 1 && l === ''))
}

function fmt(ts?: number): string {
  return ts ? new Date(ts).toLocaleString('zh-CN', { hour12: false }) : '-'
}

async function cancelJob(id: string): Promise<void> {
  const job = readJob(id)
  if (!job) die(`找不到作业 ${id}`)
  if (effective(job) !== 'running') {
    console.log(`作业 ${id} 已结束（${effective(job)}）。`)
    return
  }
  // 先发 SIGTERM：子进程会中止模型回合并杀掉它启动的命令
  try {
    process.kill(job.pid!, 'SIGTERM')
  } catch {
    /* 已退出 */
  }
  for (let i = 0; i < 30 && isAlive(job.pid); i++) await new Promise((r) => setTimeout(r, 500))
  if (isAlive(job.pid)) {
    // 兜底：杀整个进程组（子进程是独立进程组的组长）
    try {
      process.kill(-job.pid!, 'SIGKILL')
    } catch {
      /* ignore */
    }
    updateJob(id, { status: 'cancelled', finishedAt: Date.now() })
    console.log(`作业 ${id} 未能正常停止，已强制结束。`)
    return
  }
  if (readJob(id)?.status === 'running') updateJob(id, { status: 'cancelled', finishedAt: Date.now() })
  console.log(`已取消作业 ${id}。`)
}

export function runJob(args: string[]): void {
  const [sub, id, extra] = args
  switch (sub) {
    case 'list': {
      const jobs = listJobs()
      if (jobs.length === 0) console.log('（暂无后台作业）')
      for (const j of jobs.slice(0, 50)) {
        console.log(`${j.id}  ${effective(j).padEnd(9)}  ${fmt(j.createdAt)}  会话 ${j.sessionId}  ${j.prompt.slice(0, 40)}`)
      }
      return
    }
    case 'status': {
      if (!id) die('用法：job status <id>')
      const j = readJob(id)
      if (!j) die(`找不到作业 ${id}`)
      console.log(`作业：${j.id}`)
      console.log(`状态：${effective(j)}${j.exitCode !== undefined ? `（退出码 ${j.exitCode}）` : ''}`)
      console.log(`会话：${j.sessionId}（续接：ask --session ${j.sessionId} "…"）`)
      console.log(`提交：${fmt(j.createdAt)}    结束：${fmt(j.finishedAt)}`)
      console.log(`提示词：${j.prompt}`)
      const errTail = tail(j.err, 3)
      if (errTail.length) console.log(`最近的错误输出：\n  ${errTail.join('\n  ')}`)
      return
    }
    case 'log': {
      if (!id) die('用法：job log <id> [行数]')
      const j = readJob(id)
      if (!j) die(`找不到作业 ${id}`)
      const n = Number(extra) || 60
      for (const l of tail(j.out, n)) console.log(l)
      return
    }
    case 'cancel': {
      if (!id) die('用法：job cancel <id>')
      void cancelJob(id).then(() => process.exit(0))
      return
    }
    default:
      die('用法：job list | status <id> | log <id> [行数] | cancel <id>', 2)
  }
}
