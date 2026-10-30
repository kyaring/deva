/**
 * 无头版的机器人与配对用户管理：`remote bots | users | pair-code | pair-cancel | remove-user`。
 * 生成 / 取消邀请码需要 serve 运行中（通过控制接口）；移除用户在 serve 未运行时直接改配置。
 */
import { join } from 'node:path'
import { getDevaHome, registerConfigIpc } from '../services/config'
import { listBots, updateBot, type BotConfig } from '../services/remote/store'
import { controlRequest, type ControlResponse } from './control'

function die(message: string, code = 1): never {
  console.error(message)
  process.exit(code)
}

function socketPath(): string {
  return join(getDevaHome(), 'control.sock')
}

function findBot(ref: string | undefined): BotConfig {
  if (!ref) die('请指定机器人：ID、@用户名或名称（见 remote bots）。')
  const name = ref.replace(/^@/, '')
  const matches = listBots().filter(
    (b) => b.id === ref || b.name === ref || (typeof b.settings.username === 'string' && b.settings.username === name)
  )
  if (matches.length === 0) die(`找不到机器人 ${ref}（见 remote bots）。`)
  if (matches.length > 1) die(`${ref} 匹配到多个机器人，请使用 ID。`)
  return matches[0]
}

function fmtTime(ts: number): string {
  return ts ? new Date(ts).toLocaleString('zh-CN', { hour12: false }) : '-'
}

function botHandle(b: BotConfig): string {
  return typeof b.settings.username === 'string' ? `@${b.settings.username}` : b.name
}

async function call(req: { cmd: string; args?: Record<string, string> }): Promise<ControlResponse | null> {
  return controlRequest(socketPath(), req)
}

async function cmdBots(): Promise<void> {
  const bots = listBots()
  if (bots.length === 0) {
    console.log('尚未添加机器人。运行 `telegram-add` 添加。')
    return
  }
  for (const b of bots) {
    console.log(`${b.id}  ${botHandle(b)}  ${b.platform}  ${b.enabled ? '启用' : '停用'}  已配对 ${b.users.length} 人`)
  }
}

function cmdUsers(ref: string | undefined): void {
  const b = findBot(ref)
  if (b.users.length === 0) {
    console.log(`${botHandle(b)} 尚无已配对用户。`)
    return
  }
  console.log(`${botHandle(b)} 的已配对用户：`)
  for (const u of b.users) console.log(`  ${u.id}  ${u.name ?? '-'}  配对于 ${fmtTime(u.pairedAt)}`)
}

async function cmdPairCode(ref: string | undefined): Promise<void> {
  const b = findBot(ref)
  const r = await call({ cmd: 'pair-code', args: { botId: b.id } })
  if (!r) die('serve 未运行：邀请码由运行中的服务生成并校验，请先启动 serve。')
  if (!r.ok) die(r.error)
  const { code, expiresAt } = r.data as { code: string; expiresAt: number }
  console.log(`邀请码：${code}（有效至 ${fmtTime(expiresAt)}，输错 5 次作废）`)
  console.log(`请让新用户在 Telegram 里给 ${botHandle(b)} 发送：/pair ${code}`)
}

async function cmdPairCancel(ref: string | undefined): Promise<void> {
  const b = findBot(ref)
  const r = await call({ cmd: 'pair-cancel', args: { botId: b.id } })
  if (!r) {
    console.log('serve 未运行，没有进行中的邀请码。')
    return
  }
  if (!r.ok) die(r.error)
  console.log('已取消当前邀请码。')
}

async function cmdRemoveUser(ref: string | undefined, userId: string | undefined): Promise<void> {
  const b = findBot(ref)
  if (!userId) die('用法：remote remove-user <机器人> <用户ID>（见 remote users）。')
  if (!b.users.some((u) => u.id === userId)) die('该用户不在配对列表中。')

  const r = await call({ cmd: 'remove-user', args: { botId: b.id, userId } })
  if (r) {
    if (!r.ok) die(r.error)
    console.log(`已移除用户 ${userId}，该用户之后发消息将需要重新配对。`)
    return
  }
  // serve 未运行：没有进程会覆盖配置，直接修改即可（与 hub.removePairedUser 的逻辑一致）
  updateBot(b.id, (c) => {
    const gone = c.users.find((u) => u.id === userId)
    const bindings = { ...c.bindings }
    if (gone) delete bindings[gone.chatId]
    return { ...c, users: c.users.filter((u) => u.id !== userId), bindings }
  })
  console.log(`已移除用户 ${userId}（serve 未运行，已直接修改配置）。`)
}

export async function runRemoteCommand(args: string[]): Promise<void> {
  registerConfigIpc()
  const [sub, ...rest] = args
  switch (sub) {
    case 'bots':
      await cmdBots()
      break
    case 'users':
      cmdUsers(rest[0])
      break
    case 'pair-code':
      await cmdPairCode(rest[0])
      break
    case 'pair-cancel':
      await cmdPairCancel(rest[0])
      break
    case 'remove-user':
      await cmdRemoveUser(rest[0], rest[1])
      break
    default:
      die('用法：remote bots | users <机器人> | pair-code <机器人> | pair-cancel <机器人> | remove-user <机器人> <用户ID>', 2)
  }
  process.exit(0)
}

