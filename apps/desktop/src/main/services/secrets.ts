import { app, ipcMain, safeStorage } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import { getDevaHome } from './config'

/**
 * 密钥安全存储（主进程）。
 * 用 Electron safeStorage 加密（OS 凭据体系：Win DPAPI / macOS Keychain / Linux libsecret），
 * 密文（base64）落盘 `~/.deva/secrets.json`（与非敏感 config.json 同一根目录，可被 DEVA_HOME 覆盖）。
 * 即便放在点目录，也**始终保持加密、绝不明文**——DPAPI 密文绑定 OS 用户账户、与文件路径无关。
 * **明文永不出主进程**——不提供 get 给渲染层，解密只在主进程内被 provider 调用时发生。
 * 详见 docs/architecture/security.md。
 */

// providerId -> base64(密文)
let store: Record<string, string> = {}
let filePath = ''
let loaded = false

export type SecretsStorageReason = 'ok' | 'unavailable' | 'weak_backend'
export interface SecretsStorageStatus {
  /** 是否允许保存 / 读取密钥（已综合后端强度判断）。 */
  available: boolean
  platform: NodeJS.Platform
  /** 仅 Linux：safeStorage 实际选用的后端（gnome_libsecret / kwallet* / basic_text / unknown）。 */
  backend: string | null
  reason: SecretsStorageReason
}

/** Linux 上认可的强后端：GNOME Keyring（libsecret）与 KDE KWallet。 */
// deva_file_aes：仅无头模式（headless）使用，主密钥来自 DEVA_MASTER_KEY 或数据目录下 0600 的文件，见 headless/electron-shim.ts
const STRONG_LINUX_BACKENDS = ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6', 'deva_file_aes']

/**
 * 当前能否安全加密存储密钥（唯一判定入口，勿直接调用 safeStorage.isEncryptionAvailable）。
 * Linux 特例：无系统密钥环时 Electron 回落到 basic_text，它用固定口令加密，实际等同明文。
 * 而 isEncryptionAvailable() 对它仍返回 true，因此必须额外检查后端，否则会静默保存「伪加密」的密钥。
 */
export function getSecretsStorageStatus(): SecretsStorageStatus {
  const platform = process.platform
  if (!safeStorage.isEncryptionAvailable()) {
    // 不可用时仍报告后端名，便于从日志判断是没有密钥环还是别的原因
    const backend = platform === 'linux' ? safeStorage.getSelectedStorageBackend() : null
    return { available: false, platform, backend, reason: 'unavailable' }
  }
  if (platform === 'linux') {
    const backend = safeStorage.getSelectedStorageBackend()
    if (!STRONG_LINUX_BACKENDS.includes(backend)) {
      return { available: false, platform, backend, reason: 'weak_backend' }
    }
    return { available: true, platform, backend, reason: 'ok' }
  }
  return { available: true, platform, backend: null, reason: 'ok' }
}

/** 从旧位置 userData/secrets.json 一次性迁移（密文原样搬运，加密不受路径影响）。 */
async function migrateLegacy(): Promise<void> {
  try {
    const legacy = join(app.getPath('userData'), 'secrets.json')
    const raw = await fs.readFile(legacy, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && Object.keys(parsed).length > 0) {
      store = parsed as Record<string, string>
      await persist() // 写到新位置 ~/.deva/secrets.json（旧文件保留，作兜底，不删）
    }
  } catch {
    // 无旧文件 / 解析失败 —— 视为空库
    store = {}
  }
}

async function ensureLoaded(): Promise<void> {
  if (loaded) return
  filePath = join(getDevaHome(), 'secrets.json')
  try {
    const raw = await fs.readFile(filePath, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') store = parsed as Record<string, string>
  } catch {
    // 新位置不存在：尝试从旧 userData 位置迁移一次
    await migrateLegacy()
  }
  loaded = true
}

/** 仅返回已保存的密钥名（不返回值），供 `secret list` 使用。 */
export async function listSecretNames(): Promise<string[]> {
  await ensureLoaded()
  return Object.keys(store).sort()
}

async function persist(): Promise<void> {
  // 密文也只应对本用户可读：mode 仅在新建文件时生效，故写后再 chmod（Windows 忽略权限位）
  await fs.writeFile(filePath, JSON.stringify(store, null, 2), { encoding: 'utf8', mode: 0o600 })
  if (process.platform !== 'win32') await fs.chmod(filePath, 0o600).catch(() => {})
}

/**
 * 主进程内部使用：取解密后的密钥。返回 null 表示未配置或无法解密。
 * 仅供 provider 适配层 / MCP 连接层在发起请求时调用，绝不经 IPC 返回渲染层。
 * 键约定：provider 用 providerId；MCP 用 `mcp:<serverId>:<field>`。
 */
export async function getSecret(key: string): Promise<string | null> {
  await ensureLoaded()
  const enc = store[key]
  if (!enc) return null
  if (!getSecretsStorageStatus().available) return null
  try {
    return safeStorage.decryptString(Buffer.from(enc, 'base64'))
  } catch {
    return null
  }
}

/**
 * 主进程内部使用：写入 / 更新密钥（空串视为删除）。加密不可用时拒绝写入（绝不静默存明文）。
 * 供 secrets:set IPC 与 MCP 连接层（mcp:<id>:<field>）共用。
 */
export async function setSecret(
  key: string,
  value: string
): Promise<{ ok: boolean; available: boolean }> {
  await ensureLoaded()
  const available = getSecretsStorageStatus().available
  if (!value) {
    delete store[key]
    await persist()
    return { ok: true, available }
  }
  if (!available) return { ok: false, available }
  store[key] = safeStorage.encryptString(value).toString('base64')
  await persist()
  return { ok: true, available }
}

/** 是否已配置某密钥（布尔，不回显明文）。 */
export async function hasSecret(key: string): Promise<boolean> {
  await ensureLoaded()
  return Boolean(store[key])
}

/** 删除某密钥（幂等）。 */
export async function deleteSecret(key: string): Promise<void> {
  await ensureLoaded()
  if (key in store) {
    delete store[key]
    await persist()
  }
}

/** 删除某前缀下的所有密钥（如删除 MCP 服务时清 `mcp:<id>:` 全部字段）。 */
export async function deleteSecretsByPrefix(prefix: string): Promise<void> {
  await ensureLoaded()
  let changed = false
  for (const k of Object.keys(store)) {
    if (k.startsWith(prefix)) {
      delete store[k]
      changed = true
    }
  }
  if (changed) await persist()
}

export function registerSecretsIpc(): void {
  // 写入 / 更新密钥；空串视为删除。加密不可用时拒绝写入（绝不静默存明文）。
  ipcMain.handle(
    'secrets:set',
    async (_e, providerId: string, key: string): Promise<{ ok: boolean; available: boolean }> => {
      await ensureLoaded()
      const available = getSecretsStorageStatus().available
      if (!key) {
        delete store[providerId]
        await persist()
        return { ok: true, available }
      }
      if (!available) return { ok: false, available }
      store[providerId] = safeStorage.encryptString(key).toString('base64')
      await persist()
      return { ok: true, available }
    }
  )

  // 是否已配置密钥（布尔，不回显明文）
  ipcMain.handle('secrets:has', async (_e, providerId: string): Promise<boolean> => {
    await ensureLoaded()
    return Boolean(store[providerId])
  })

  ipcMain.handle('secrets:delete', async (_e, providerId: string): Promise<{ ok: true }> => {
    await ensureLoaded()
    delete store[providerId]
    await persist()
    return { ok: true }
  })

  // 已配置密钥的 providerId 列表
  ipcMain.handle('secrets:list', async (): Promise<string[]> => {
    await ensureLoaded()
    return Object.keys(store)
  })

  // 当前环境是否支持加密（用于 UI 降级提示）
  ipcMain.handle('secrets:available', (): boolean => getSecretsStorageStatus().available)

  // 存储状态诊断：Linux 下据此给出「安装 / 启用系统密钥环」的具体指引
  ipcMain.handle('secrets:status', (): SecretsStorageStatus => getSecretsStorageStatus())
}
