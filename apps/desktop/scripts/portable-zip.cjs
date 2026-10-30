/**
 * electron-builder afterAllArtifactBuild 钩子：给 Windows 便携版 zip 套一层 `Deva\` 目录。
 *
 * electron-builder 打 Windows zip 时把文件直接放在压缩包根目录（写死，没有配置项），用户右键「解压到当前文件夹」
 * 会把二十来个文件撒在下载目录里；套一层后得到干净的 Deva\Deva.exe。目录名不带版本号：更新时删掉旧目录、
 * 原地解压新版，路径不变，固定到任务栏的图标、桌面快捷方式仍然有效。
 *
 * 做法：所有产物打完后（安装包也已从 win-unpacked 打好），把 win-unpacked 临时改名为 Deva，用 electron-builder
 * 打 zip 目标时用的同一个函数（同一个 7za、同样的压缩参数）重打这个 zip，再改回原名。
 * 只打 x64（与 CI 一致），对应的目录就是 win-unpacked。
 */
const fs = require('fs')
const path = require('path')

const TOP_DIR = 'Deva'

/** 刚生成的文件可能正被杀毒软件扫描，Windows 上改名偶尔 EPERM / EBUSY：稍等重试。 */
async function rename(from, to) {
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(from, to)
      return
    } catch (e) {
      if (i >= 9 || (e.code !== 'EPERM' && e.code !== 'EBUSY')) throw e
      await new Promise((r) => setTimeout(r, 500))
    }
  }
}

exports.default = async function portableZip(result) {
  const zip = result.artifactPaths.find((p) => p.endsWith('-portable.zip'))
  if (!zip) return []
  const unpacked = path.join(result.outDir, 'win-unpacked')
  if (!fs.existsSync(unpacked)) throw new Error(`找不到 ${unpacked}，无法给便携版 zip 套目录`)
  // archive() 是 app-builder-lib 的内部函数，经 electron-builder 的位置解析（pnpm 下项目里直接 require 不到）
  const builderDir = path.dirname(require.resolve('electron-builder/package.json'))
  const { archive } = require(
    require.resolve('app-builder-lib/out/targets/archive', { paths: [builderDir] })
  )

  const staged = path.join(result.outDir, TOP_DIR)
  fs.rmSync(staged, { recursive: true, force: true })
  await rename(unpacked, staged)
  try {
    // 先删：archive() 发现压缩包比目录新会当作「已是最新」直接跳过
    fs.rmSync(zip, { force: true })
    await archive('zip', zip, staged, {
      compression: result.configuration.compression,
      withoutDir: false
    })
  } finally {
    await rename(staged, unpacked)
  }
  return []
}
