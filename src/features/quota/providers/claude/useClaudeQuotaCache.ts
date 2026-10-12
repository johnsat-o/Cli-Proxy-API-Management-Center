import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuotaStore } from '@/stores/useQuotaStore';
import type { AuthFileItem } from '@/types';
import { getQuotaCacheKey } from '@/utils/quota/identity';
import type { QuotaFileEntry } from '../../logic';
import { CLAUDE_CONFIG, readFreshClaudeQuota } from './data';

/** Page load / route change: show usage cached in the last 120 s, with no network call. */
export function useClaudeQuotaCacheHydrate(entries: QuotaFileEntry[]) {
  const { t } = useTranslation();

  useEffect(() => {
    const hydrated: Record<string, ReturnType<typeof CLAUDE_CONFIG.buildSuccessState>> = {};
    const current = useQuotaStore.getState().claudeQuota;
    entries.forEach(({ type, file }) => {
      if (type !== 'claude') return;
      const key = getQuotaCacheKey(file);
      if ((current[key]?.status ?? 'idle') !== 'idle') return;
      const data = readFreshClaudeQuota(file, t);
      if (data) hydrated[key] = CLAUDE_CONFIG.buildSuccessState(data);
    });
    if (Object.keys(hydrated).length === 0) return;
    useQuotaStore.getState().setClaudeQuota((prev) => ({ ...prev, ...hydrated }));
  }, [entries, t]);
}

/** After a 429, retry each card once when its Retry-After elapses. */
export function useClaudeQuotaAutoRetry(
  entries: QuotaFileEntry[],
  retry: (file: AuthFileItem) => void
) {
  const claudeQuota = useQuotaStore((state) => state.claudeQuota);
  const fired = useRef(new Set<string>());

  useEffect(() => {
    const timers: number[] = [];
    entries.forEach(({ type, file }) => {
      if (type !== 'claude') return;
      const cacheKey = getQuotaCacheKey(file);
      const notice = claudeQuota[cacheKey]?.notice;
      if (!notice?.autoRetry) return;
      const key = `${cacheKey}:${notice.retryAtMs}`;
      if (fired.current.has(key)) return;
      const delay = Math.max(0, notice.retryAtMs - Date.now());
      timers.push(
        window.setTimeout(() => {
          fired.current.add(key);
          retry(file);
        }, delay)
      );
    });
    return () => timers.forEach((id) => window.clearTimeout(id));
  }, [claudeQuota, entries, retry]);
}

/** Whole seconds left until `targetMs`, ticking once a second while above zero. */
export function useSecondsUntil(targetMs: number | null | undefined): number {
  const [now, setNow] = useState(() => Date.now());
  const active = typeof targetMs === 'number' && targetMs > now;

  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [active, targetMs]);

  return typeof targetMs === 'number' ? Math.max(0, Math.ceil((targetMs - now) / 1000)) : 0;
}
