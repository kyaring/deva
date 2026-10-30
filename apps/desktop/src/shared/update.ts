/**
 * 检查更新的状态——主进程（services/updater.ts）持有，经 update:state 推给渲染层（设置 → 关于）。
 * 状态放主进程，是为了下载途中离开关于页再回来，进度还接得上。
 */

/** 所有版本的下载页：检查失败时给用户兜底。 */
export const RELEASES_URL = 'https://github.com/kyaring/deva/releases'

export interface UpdateRelease {
  /** 不带 v 前缀，如 0.1.7 */
  version: string
  /** 该版本的 Release 页面（更新说明） */
  pageUrl: string
}

/**
 * 有新版时怎么装：
 *  - auto：Windows 上用 exe 安装的——应用内下载，点「重启并安装」覆盖安装；
 *  - portable：Windows 便携版（zip 解压运行的）——在浏览器里下载新版 zip，用户解压替换原文件夹；
 *  - manual：mac（包没正式签名，做不了自动安装）及其他情形——在浏览器里下载对应的安装包，用户自己装。
 */
export type UpdateMode = 'auto' | 'manual' | 'portable'

export type UpdateState =
  | { phase: 'idle' }
  | { phase: 'checking' }
  | { phase: 'latest' }
  | { phase: 'available'; release: UpdateRelease; mode: UpdateMode }
  | { phase: 'downloading'; release: UpdateRelease; percent: number }
  | { phase: 'downloaded'; release: UpdateRelease }
  /** stage=download 时带上 release：界面可以「重试下载」，不用重新检查。 */
  | { phase: 'error'; stage: 'check' | 'download'; message: string; release?: UpdateRelease }
