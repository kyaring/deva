/**
 * 主进程生成、会显示给用户的文案（错误提示等）按界面语言出中 / 英文。
 * 取的是生成那一刻的 config.locale：已落盘的错误保持当时的语言，切换语言后不回头改写。
 */
import { getConfig } from './services/config'

export function isEn(): boolean {
  return getConfig().locale === 'en'
}
