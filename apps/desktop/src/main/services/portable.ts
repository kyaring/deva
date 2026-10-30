import { app } from 'electron'
import { execFile } from 'child_process'
import { existsSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { getAppIcon } from './tray-icon'

/**
 * Windows 便携版（zip 解压后直接运行 Deva.exe，见 electron-builder.yml 的 zip 目标）。
 *
 * 与安装版的区别只在程序目录里有没有 NSIS 卸载程序；开发模式两者都不算。数据目录两者共用（~/.deva），
 * 这里只处理「没经过安装」带来的差异：检查更新的下载方式（updater.ts）与系统通知的显示名和图标。
 */

/** 程序目录里有 NSIS 卸载程序（electron-builder 固定命名为「Uninstall <productName>.exe」）= 经 exe 安装程序装的。 */
export function installedByNsis(): boolean {
  return existsSync(join(dirname(process.execPath), 'Uninstall Deva.exe'))
}

/** Windows 便携版：打包产物但不是装出来的。 */
export function isPortable(): boolean {
  return process.platform === 'win32' && app.isPackaged && !installedByNsis()
}

/**
 * 便携版的系统通知身份。Windows 按 AppUserModelID 找通知的显示名和图标：安装版由开始菜单快捷方式提供，
 * 便携版没有快捷方式，通知标题会显示成原始 ID 且没有图标。这里在当前用户注册表
 * `HKCU\Software\Classes\AppUserModelId\<id>` 写上显示名「Deva」和图标（运行期生成，存在 userData 下）。
 *
 * 必须赶在这个 ID 的第一条通知之前写：Windows 会记住首次通知时的显示名，之后再写不生效。
 * 每次启动都覆盖写一遍，程序文件夹挪了图标路径也能跟上；失败静默，通知照常弹，只是显示原始 ID。
 */
export function registerToastIdentity(appId: string): void {
  if (!isPortable()) return
  const key = `HKCU\\Software\\Classes\\AppUserModelId\\${appId}`
  const set = (name: string, value: string): void => {
    execFile(
      'reg',
      ['add', key, '/v', name, '/t', 'REG_SZ', '/d', value, '/f'],
      { windowsHide: true },
      () => {}
    )
  }
  set('DisplayName', 'Deva')
  try {
    const icon = join(app.getPath('userData'), 'notification-icon.png')
    writeFileSync(icon, getAppIcon().toPNG({ scaleFactor: 2 }))
    set('IconUri', icon)
  } catch {
    /* 图标写不了：只有显示名，没有图标 */
  }
}
