/**
 * 无图形界面（headless）运行时的 `electron` 替代实现。
 *
 * 仅在 headless 构建中通过 vite alias 把 `electron` 指向这里，桌面版永远不会加载它。
 * 服务层只依赖少量 API：
 *  - ipcMain.handle：渲染层接口，无头模式下无人调用，仅登记；
 *  - app 的数据目录与生命周期、safeStorage（密钥加密）、net.fetch（网络，支持代理）；
 * 与界面相关的能力（窗口、托盘、系统通知、原生对话框、剪贴板、终端）给出无副作用的空实现，
 * 服务层原有的「窗口为空则降级」分支会自然生效。
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { rename } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { connect as tlsConnect } from 'node:tls'
import { Agent, ProxyAgent, fetch as undiciFetch, type Dispatcher } from 'undici'
import { SocksClient } from 'socks'

declare const __DEVA_VERSION__: string

/** 密钥后端标识。secrets.ts 据此把它视为可接受的强后端（仅 headless 会出现）。 */
export const HEADLESS_BACKEND = 'deva_file_aes'

function devaHome(): string {
  const override = process.env.DEVA_HOME?.trim()
  return override && override.length > 0 ? override : join(homedir(), '.deva')
}

// ───────── 生命周期 ─────────

let quitHandler: (() => void) | null = null
/** 无头入口注册收尾逻辑：app.quit() 时执行（断开通道、等待回合落盘），而不是直接杀进程。 */
export function setQuitHandler(fn: () => void): void {
  quitHandler = fn
}

type Listener = (...args: unknown[]) => void
const appListeners = new Map<string, Listener[]>()

function on(event: string, fn: Listener): typeof app {
  const list = appListeners.get(event) ?? []
  list.push(fn)
  appListeners.set(event, list)
  return app
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** 单实例：数据目录下的 pid 文件。已有存活实例时返回 false（同一账号只能有一个调度器，否则任务双触发）。 */
function acquirePidLock(): boolean {
  const dir = devaHome()
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'headless.pid')
  if (existsSync(file)) {
    const other = Number.parseInt(readFileSync(file, 'utf8'), 10)
    if (other && other !== process.pid && isAlive(other)) return false
  }
  writeFileSync(file, String(process.pid), { mode: 0o600 })
  process.once('exit', () => {
    try {
      if (readFileSync(file, 'utf8').trim() === String(process.pid)) rmSync(file)
    } catch {
      /* 忽略：文件已被清理 */
    }
  })
  return true
}

export const app = {
  isPackaged: false,
  getVersion: (): string => __DEVA_VERSION__,
  getPath: (name: string): string => {
    if (name === 'home') return homedir()
    if (name === 'temp') return tmpdir()
    // userData 等其它路径统一落在数据目录（与桌面版的 DEVA_HOME 语义一致）
    return devaHome()
  },
  whenReady: (): Promise<void> => Promise.resolve(),
  isReady: (): boolean => true,
  on,
  once: on,
  quit: (): void => {
    if (quitHandler) quitHandler()
    else process.exit(0)
  },
  requestSingleInstanceLock: (): boolean => acquirePidLock(),
  runningUnderARM64Translation: false,
}

// ───────── 渲染层 IPC（无头模式无人调用，仅登记以保持服务层代码路径不变） ─────────

const handlers = new Map<string, (...args: unknown[]) => unknown>()

/** 无头入口内部复用已登记的 IPC 处理函数（如拉取模型清单），等价于渲染层的 invoke。 */
export async function invokeIpc(channel: string, ...args: unknown[]): Promise<unknown> {
  const fn = handlers.get(channel)
  if (!fn) throw new Error(`未注册的接口：${channel}`)
  return await fn(null, ...args)
}

export const ipcMain = {
  handle(channel: string, fn: (...args: unknown[]) => unknown): void {
    handlers.set(channel, fn)
  },
  removeHandler(channel: string): void {
    handlers.delete(channel)
  },
  on(_channel: string, _fn: unknown): void {
    /* 无渲染层：忽略 */
  },
  removeAllListeners(): void {
    /* 无渲染层：忽略 */
  }
}

// ───────── 密钥加密：AES-256-GCM，主密钥来自 DEVA_MASTER_KEY 或数据目录下 0600 的文件 ─────────

const CIPHER_PREFIX = Buffer.from('DV1')
let masterKey: Buffer | null = null

function loadMasterKey(): Buffer {
  if (masterKey) return masterKey
  let raw = process.env.DEVA_MASTER_KEY?.trim() ?? ''
  if (!raw) {
    const dir = devaHome()
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'master.key')
    if (!existsSync(file)) writeFileSync(file, randomBytes(32).toString('base64'), { mode: 0o600 })
    raw = readFileSync(file, 'utf8').trim()
  }
  const key = Buffer.from(raw, 'base64')
  if (key.length !== 32) throw new Error('主密钥必须是 32 字节的 base64（DEVA_MASTER_KEY 或 master.key）')
  masterKey = key
  return key
}

export const safeStorage = {
  isEncryptionAvailable: (): boolean => {
    try {
      loadMasterKey()
      return true
    } catch {
      return false
    }
  },
  getSelectedStorageBackend: (): string => HEADLESS_BACKEND,
  encryptString(plain: string): Buffer {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', loadMasterKey(), iv)
    const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
    return Buffer.concat([CIPHER_PREFIX, iv, cipher.getAuthTag(), body])
  },
  decryptString(blob: Buffer): string {
    if (blob.subarray(0, 3).compare(CIPHER_PREFIX) !== 0) throw new Error('密文格式不符')
    const iv = blob.subarray(3, 15)
    const tag = blob.subarray(15, 31)
    const body = blob.subarray(31)
    const decipher = createDecipheriv('aes-256-gcm', loadMasterKey(), iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')
  }
}

// ───────── 网络：支持 HTTP(S)_PROXY / NO_PROXY（桌面版走系统代理，无头版走环境变量） ─────────

const proxyAgents = new Map<string, Dispatcher>()

function envValue(...names: string[]): string | undefined {
  for (const n of names) {
    const v = process.env[n]?.trim()
    if (v) return v
  }
  return undefined
}

/** NO_PROXY：逗号分隔的主机名 / 域名后缀（如 localhost、.internal.lan），* 表示全部直连。 */
function bypassesProxy(host: string): boolean {
  const list = envValue('NO_PROXY', 'no_proxy')
  if (!list) return false
  return list
    .split(',')
    .map((s) => s.trim().replace(/^\./, ''))
    .filter(Boolean)
    .some((p) => p === '*' || host === p || host.endsWith(`.${p}`))
}

/**
 * SOCKS5 出口：先经代理与目标建立 TCP 隧道（域名交给代理解析，即 socks5h 语义），
 * https 再在隧道之上完成 TLS 握手。undici 的 connect 钩子负责把它接进请求链路。
 */
function socksDispatcher(proxy: URL): Dispatcher {
  const host = proxy.hostname
  const port = Number(proxy.port) || 1080
  const userId = proxy.username ? decodeURIComponent(proxy.username) : undefined
  const password = proxy.password ? decodeURIComponent(proxy.password) : undefined
  return new Agent({
    connect: (opts, callback) => {
      const secure = opts.protocol === 'https:'
      const destPort = Number(opts.port) || (secure ? 443 : 80)
      const connectOnce = () =>
        SocksClient.createConnection({
          proxy: { host, port, type: 5, userId, password },
          command: 'connect',
          destination: { host: String(opts.hostname), port: destPort },
          timeout: 10_000
        })
      // 代理偶发握手卡住：失败后重试一次，避免单次抖动就让请求失败
      const connectWithRetry = () => connectOnce().catch(() => connectOnce())
      connectWithRetry()
        .then(({ socket }) => {
          if (!secure) {
            callback(null, socket)
            return
          }
          const tls = tlsConnect({ socket, servername: opts.servername || String(opts.hostname) })
          tls.once('secureConnect', () => callback(null, tls))
          tls.once('error', (err) => callback(err, null))
        })
        .catch((err: Error) => callback(err, null))
    }
  })
}

/** 按 HTTPS_PROXY / HTTP_PROXY（socks5:// 或 http://）选择出口；未配置或命中 NO_PROXY 则直连。 */
function dispatcherFor(url: URL): Dispatcher | undefined {
  const proxy =
    url.protocol === 'https:'
      ? envValue('HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'HTTP_PROXY', 'http_proxy')
      : envValue('HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy')
  if (!proxy || bypassesProxy(url.hostname)) return undefined
  let agent = proxyAgents.get(proxy)
  if (!agent) {
    const parsed = new URL(proxy)
    agent = /^socks/i.test(parsed.protocol) ? socksDispatcher(parsed) : new ProxyAgent(proxy)
    proxyAgents.set(proxy, agent)
  }
  return agent
}

export const net = {
  fetch(input: string | URL, init?: RequestInit): Promise<Response> {
    const url = new URL(typeof input === 'string' ? input : input.toString())
    return undiciFetch(input, { ...init, dispatcher: dispatcherFor(url) } as never) as unknown as Promise<Response>
  },
  request(): never {
    throw new Error('headless: net.request 未实现，请改用 net.fetch')
  }
}

// ───────── 系统外壳：无图形界面时的降级 ─────────

/**
 * 让全局 fetch（工具里的 web_fetch 等）也走 net.fetch 的代理出口。
 * bun 原生 fetch 不支持 socks5:// 代理，直接报 UnsupportedProxyProtocol；这里统一改走 undici + SOCKS 出口。
 * 只在无头进程入口调用一次。
 */
export function installNetworkFetch(): void {
  const proxied = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (typeof input === 'string' || input instanceof URL) return net.fetch(input, init)
    // Request 对象：沿用它的方法、头、体与信号，init 中的字段优先
    const req = input as Request
    return net.fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body as BodyInit | null,
      redirect: req.redirect,
      signal: req.signal,
      ...init
    } as RequestInit)
  }
  globalThis.fetch = proxied as typeof fetch
}

export const shell = {
  /** 非空字符串 = 失败（与 Electron 约定一致）。无图形界面时无法在本机打开。 */
  openPath: async (p: string): Promise<string> => `无图形界面，无法在本机打开：${p}`,
  openExternal: async (url: string): Promise<void> => {
    console.info(`[headless] 请在浏览器打开：${url}`)
  },
  showItemInFolder: (): void => {
    /* 无图形界面 */
  },
  /** 「删除」改为移入数据目录下的 trash/ 以便恢复；跨设备失败则报错而不是直接删除。 */
  trashItem: async (p: string): Promise<void> => {
    const dir = join(devaHome(), 'trash')
    mkdirSync(dir, { recursive: true })
    await rename(p, join(dir, `${Date.now()}-${basename(p)}`))
  }
}

export const dialog = {
  /** 无图形界面无法弹出原生选择框：一律视为用户取消。 */
  showOpenDialog: async (): Promise<{ canceled: boolean; filePaths: string[] }> => ({
    canceled: true,
    filePaths: []
  }),
  showSaveDialog: async (): Promise<{ canceled: boolean; filePath?: string }> => ({ canceled: true }),
  showMessageBox: async (): Promise<{ response: number; checkboxChecked: boolean }> => ({
    response: 0,
    checkboxChecked: false
  })
}

export class Notification {
  static isSupported(): boolean {
    return false
  }
  constructor(_opts?: unknown) {}
  on(): this {
    return this
  }
  show(): void {}
  close(): void {}
}

/**
 * 图片处理的空实现：isEmpty() 为 true，图片处理因此走「原样发送、超限则报错」的分支。
 * 无头版不做缩放（需要缩放的大图会被拒绝并提示），这是有意的功能降级。
 */
class EmptyImage {
  isEmpty(): boolean {
    return true
  }
  getSize(): { width: number; height: number } {
    return { width: 0, height: 0 }
  }
  resize(): EmptyImage {
    return this
  }
  toPNG(): Buffer {
    return Buffer.alloc(0)
  }
  toJPEG(): Buffer {
    return Buffer.alloc(0)
  }
  toDataURL(): string {
    return ''
  }
}

export const nativeImage = {
  createFromBuffer: (_buf: Buffer): EmptyImage => new EmptyImage(),
  createEmpty: (): EmptyImage => new EmptyImage(),
  createThumbnailFromPath: async (_p: string, _opts?: unknown): Promise<EmptyImage> => new EmptyImage()
}

export const nativeTheme = {
  shouldUseDarkColors: false,
  themeSource: 'system' as const,
  on(): void {}
}

export const clipboard = {
  readText: (): string => '',
  writeText: (_text: string): void => {}
}

export const Menu = {
  buildFromTemplate: (_t: unknown): object => ({}),
  setApplicationMenu: (_m: unknown): void => {}
}

export class Tray {
  constructor() {
    throw new Error('headless 模式没有系统托盘')
  }
}

export class BrowserWindow {
  static getAllWindows(): BrowserWindow[] {
    return []
  }
  static getFocusedWindow(): null {
    return null
  }
}

export const utilityProcess = {
  fork(): never {
    throw new Error('headless 模式不提供集成终端')
  }
}
