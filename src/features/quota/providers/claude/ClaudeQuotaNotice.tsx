/**
 * Claude rate-limit note: where the shown numbers came from and when the
 * lookup is retried ("as of 23:52, Anthropic rate-limited the lookup, retrying in 41 s").
 */

import { useTranslation } from 'react-i18next';
import type { ClaudeQuotaNotice as Notice } from '@/types';
import { useSecondsUntil } from './useClaudeQuotaCache';

const formatClock = (ms: number, language?: string) =>
  new Date(ms).toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit', hour12: false });

export function ClaudeQuotaNotice({ notice, className }: { notice: Notice; className?: string }) {
  const { t, i18n } = useTranslation();
  const seconds = useSecondsUntil(notice.autoRetry ? notice.retryAtMs : null);
  const time = notice.asOfMs === null ? '--:--' : formatClock(notice.asOfMs, i18n.resolvedLanguage);

  const parts: string[] = [];
  if (notice.source === 'cache') parts.push(t('claude_quota.rate_limited_as_of', { time }));
  else if (notice.source === 'proxy') {
    parts.push(t('claude_quota.proxy_last_reply', { time }));
    parts.push(t('claude_quota.rate_limited'));
  } else parts.push(t('claude_quota.rate_limited'));
  parts.push(
    notice.autoRetry ? t('claude_quota.retrying_in', { seconds }) : t('claude_quota.retry_manually')
  );

  return (
    <div role="status" className={className}>
      {parts.join(', ')}
    </div>
  );
}
