import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AutoResumePending } from '../hooks/useAutoResumeOnLimit';
import { MAX_AUTO_RESUME_ATTEMPTS } from '../hooks/useAutoResumeOnLimit';

export interface AutoResumeBarProps {
  pending: AutoResumePending;
  onCancel: () => void;
}

function formatRemaining(ms: number): string {
  if (ms < 60_000) {
    return `${Math.max(1, Math.ceil(ms / 1000))}s`;
  }
  const totalMinutes = Math.ceil(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

/**
 * Slim status bar shown above the input box while an automatic session resume
 * is scheduled (usage limit exhausted and the auto-resume toggle is on).
 */
export function AutoResumeBar({ pending, onCancel }: AutoResumeBarProps) {
  const { t } = useTranslation();

  // 1s tick so the "(in Xm)" countdown stays current.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((c) => c + 1), 1000);
    return () => window.clearInterval(id);
  }, []);

  const remainingMs = Math.max(0, pending.fireAtMs - Date.now());
  const timeLabel = new Date(pending.fireAtMs).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <div className="auto-resume-bar" role="status">
      <span className="codicon codicon-sync auto-resume-bar-icon" />
      <span className="auto-resume-bar-text">
        {t('chat.autoResume.countdown', {
          time: timeLabel,
          remaining: formatRemaining(remainingMs),
          defaultValue: 'Usage limit reached — auto-resume at {{time}} (in {{remaining}})',
        })}
        {pending.attempt > 1 && (
          <span className="auto-resume-bar-attempt">
            {' · '}
            {t('chat.autoResume.attempt', {
              current: pending.attempt,
              max: MAX_AUTO_RESUME_ATTEMPTS,
              defaultValue: 'attempt {{current}}/{{max}}',
            })}
          </span>
        )}
      </span>
      <button className="auto-resume-bar-cancel" onClick={onCancel}>
        {t('common.cancel', { defaultValue: 'Cancel' })}
      </button>
    </div>
  );
}

export default AutoResumeBar;
