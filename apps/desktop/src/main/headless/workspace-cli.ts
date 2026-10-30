/**
 * 无头版工作区管理：`workspace show | set <绝对路径> | unset`。
 * 设置的是 IM / ask 新建对话的默认工作区（挂载为 focusRoot），之后新对话的命令默认在该目录下执行。
 * 已存在的对话保留原有挂载；需要切换时发送 /new 开新对话。
 */
import { existsSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { getConfig, registerConfigIpc, setConfig } from '../services/config'

interface WorkspaceConfig {
  imDefaultWorkspace?: unknown
}

function die(message: string, code = 1): never {
  console.error(message)
  process.exit(code)
}

function current(): string | null {
  const v = (getConfig() as unknown as WorkspaceConfig).imDefaultWorkspace
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

export function runWorkspaceCommand(args: string[]): void {
  registerConfigIpc()
  const [sub, path] = args
  switch (sub) {
    case 'show': {
      const cur = current()
      console.log(cur ? `IM 新对话的默认工作区：${cur}` : 'IM 新对话的默认工作区：未设置（命令回落到主目录）')
      break
    }
    case 'set': {
      if (!path) die('用法：workspace set <绝对路径>')
      if (!isAbsolute(path)) die('请使用绝对路径。')
      if (!existsSync(path) || !statSync(path).isDirectory()) die(`目录不存在：${path}`)
      setConfig({ imDefaultWorkspace: path } as never)
      console.log(`已设置默认工作区：${path}。发送 /new 开始一个使用它的新对话；服务需重启后生效。`)
      break
    }
    case 'unset':
      setConfig({ imDefaultWorkspace: null } as never)
      console.log('已取消默认工作区（新对话回落到主目录）。服务需重启后生效。')
      break
    default:
      die('用法：workspace show | set <绝对路径> | unset', 2)
  }
  process.exit(0)
}
