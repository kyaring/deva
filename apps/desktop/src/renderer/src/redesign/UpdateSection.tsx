import { useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2, Download, ExternalLink, Loader2, RefreshCw, RotateCw } from 'lucide-react'
import { useI18n } from '../i18n/i18n'
import { RELEASES_URL, type UpdateState } from '../../../shared/update'

const IS_MAC = navigator.userAgent.includes('Mac')

/**
 * 关于页的「检查更新」：只在点按钮时检查。状态由主进程持有（services/updater.ts），这里只展示与触发——
 * 下载途中离开关于页再回来，进度照样接得上。
 */
export function UpdateSection(): React.JSX.Element {
  const { t } = useI18n()
  const [state, setState] = useState<UpdateState>({ phase: 'idle' })
  const [installing, setInstalling] = useState(false)

  useEffect(() => {
    let pushed = false
    const off = window.deva.update.onState((s) => {
      pushed = true
      setState(s)
    })
    // 先订阅再取快照；取回之前已收到推送就以推送为准（快照可能更旧）
    void window.deva.update.getState().then((s) => {
      if (!pushed) setState(s)
    })
    return off
  }, [])

  const check = (): void => void window.deva.update.check()
  const download = (): void => void window.deva.update.download()
  const install = (): void => {
    setInstalling(true)
    void window.deva.update.install()
  }
  const link = (href: string, label: string): React.JSX.Element => (
    <a className="cf-update__link" href={href} target="_blank" rel="noreferrer">
      {label}
      <ExternalLink size={11} />
    </a>
  )

  if (state.phase === 'available') {
    const { release, mode } = state
    return (
      <div className="cf-update">
        <div className="cf-update__status">
          {t('settings.update.available').replace('{version}', `v${release.version}`)}
          {link(release.pageUrl, t('settings.update.notes'))}
        </div>
        <button className="btn btn--primary btn--sm" onClick={download}>
          <Download size={13} />
          {mode === 'auto'
            ? t('settings.update.download')
            : mode === 'portable'
              ? t('settings.update.downloadPortable')
              : t('settings.update.downloadInstaller')}
        </button>
        {mode === 'manual' && (
          <p className="cf-update__hint">
            {IS_MAC ? t('settings.update.manualHintMac') : t('settings.update.manualHint')}
          </p>
        )}
        {mode === 'portable' && (
          <p className="cf-update__hint">{t('settings.update.portableHint')}</p>
        )}
      </div>
    )
  }

  if (state.phase === 'downloading') {
    return (
      <div className="cf-update">
        <div className="cf-update__status">
          {t('settings.update.downloading').replace('{percent}', String(state.percent))}
        </div>
        <div className="cf-update__bar">
          <div className="cf-update__fill" style={{ width: `${state.percent}%` }} />
        </div>
      </div>
    )
  }

  if (state.phase === 'downloaded') {
    return (
      <div className="cf-update">
        <div className="cf-update__status is-ok">
          <CheckCircle2 size={13} />
          {t('settings.update.downloaded').replace('{version}', `v${state.release.version}`)}
        </div>
        <button className="btn btn--primary btn--sm" onClick={install} disabled={installing}>
          {installing ? <Loader2 size={13} className="spin" /> : <RotateCw size={13} />}
          {t('settings.update.install')}
        </button>
        <p className="cf-update__hint">{t('settings.update.installHint')}</p>
      </div>
    )
  }

  if (state.phase === 'error') {
    const failedDownload = state.stage === 'download'
    return (
      <div className="cf-update">
        <div className="cf-update__status is-error">
          <AlertTriangle size={13} />
          {failedDownload ? t('settings.update.downloadFailed') : t('settings.update.checkFailed')}
        </div>
        <p className="cf-update__hint cf-update__hint--mono">{state.message}</p>
        <div className="cf-update__actions">
          <button className="btn btn--sm" onClick={failedDownload ? download : check}>
            <RefreshCw size={13} />
            {t('settings.update.retry')}
          </button>
          {link(state.release?.pageUrl ?? RELEASES_URL, t('settings.update.openReleases'))}
        </div>
      </div>
    )
  }

  const checking = state.phase === 'checking'
  return (
    <div className="cf-update">
      <button className="btn btn--sm" onClick={check} disabled={checking}>
        {checking ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />}
        {checking ? t('settings.update.checking') : t('settings.update.check')}
      </button>
      {state.phase === 'latest' && (
        <div className="cf-update__status is-ok">
          <CheckCircle2 size={13} />
          {t('settings.update.latest')}
        </div>
      )}
    </div>
  )
}
