/**
 * electron-builder afterPack 钩子：给 mac 包做 ad-hoc 签名（codesign --sign -）。
 *
 * 为什么要签：没有 Apple 开发者证书时 electron-builder 直接跳过签名，可它改过 Info.plist、换了可执行文件名，
 * Electron 自带的签名就对不上了——从网上下载后打开会提示「已损坏」，用户得去终端跑 xattr -cr。
 * ad-hoc 签名不要证书、不花钱，签完后变成普通的「无法验证开发者」，到「隐私与安全性」里点「仍要打开」即可。
 *
 * 局限：ad-hoc 的签名身份每次构建都不同，所以做不了 mac 自动更新（Squirrel.Mac 要求新旧版签名同源），
 * 升级后钥匙串等授权也可能要重新允许。将来有了 Developer ID 证书，electron-builder 会在本钩子之后用正式证书重签。
 *
 * 为什么挂 afterPack 而不是 afterSign：没发生签名时 electron-builder 会跳过 afterSign 钩子。
 */
const { execFileSync } = require('child_process')
const path = require('path')

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return
  // codesign 只有 macOS 上有；在别的系统上交叉打 mac 包时只能跳过
  if (process.platform !== 'darwin') {
    console.warn('  • 非 macOS 环境，跳过 ad-hoc 签名')
    return
  }
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  // --deep 连同内嵌的 Electron Framework、各 Helper.app 一起签；不加 hardened runtime——
  // 它会开启库校验，而 ad-hoc 签名没有团队 ID，加载 Framework 时会被拒
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' })
  // 签坏了宁可打包失败，也不要发出一个打不开的包
  execFileSync('codesign', ['--verify', '--deep', '--verbose=2', app], { stdio: 'inherit' })
}
