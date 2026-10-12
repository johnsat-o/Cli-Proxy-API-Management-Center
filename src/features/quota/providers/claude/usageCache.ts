/**
 * Claude usage cache and rate-limit fallbacks.
 *
 * Anthropic rate-limits `/api/oauth/usage` per token (HTTP 429, Retry-After
 * around 270 s), so the last good payload is kept in localStorage per
 * auth_index. React-free so tests can consume it directly.
 */

import type { TFunction } from 'i18next';
import type { AuthFileItem, ClaudeQuotaWindow, ClaudeUsagePayload } from '@/types';
import { claudePeriodHours, formatUnixSeconds } from '@/utils/quota';

/** A page load reuses a usage payload younger than this without a network call. */
export const CLAUDE_USAGE_CACHE_TTL_MS = 120 * 1000;
/** The plan type rarely changes; the profile call is skipped while this holds. */
export const CLAUDE_PLAN_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const CLAUDE_RETRY_AFTER_DEFAULT_MS = 60 * 1000;
export const CLAUDE_RETRY_AFTER_MAX_MS = 300 * 1000;

const STORAGE_KEY = 'cli-proxy-claude-usage-cache-v1';

export interface ClaudeUsageCacheEntry {
  usage?: ClaudeUsagePayload;
  usageAt?: number;
  planType?: string | null;
  planAt?: number;
}

type CacheMap = Record<string, ClaudeUsageCacheEntry>;

const readAll = (): CacheMap => {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as CacheMap) : {};
  } catch {
    return {};
  }
};

export const readClaudeUsageCache = (authIndex: string): ClaudeUsageCacheEntry | null =>
  readAll()[authIndex] ?? null;

export const writeClaudeUsageCache = (authIndex: string, patch: ClaudeUsageCacheEntry) => {
  try {
    const all = readAll();
    all[authIndex] = { ...all[authIndex], ...patch };
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    // Storage full or blocked: the page still works, it just fetches live.
  }
};

/** Retry-After in ms from a relayed header map: seconds or an HTTP date, capped at 300 s. */
export const parseRetryAfterMs = (
  header: Record<string, string[] | string> | undefined,
  now = Date.now()
): number => {
  const entry = Object.entries(header ?? {}).find(([key]) => key.toLowerCase() === 'retry-after');
  const raw = Array.isArray(entry?.[1]) ? entry?.[1][0] : entry?.[1];
  const text = typeof raw === 'string' ? raw.trim() : '';
  let ms = Number.NaN;
  if (/^\d+(\.\d+)?$/.test(text)) ms = Number(text) * 1000;
  else if (text) ms = Date.parse(text) - now;
  if (!Number.isFinite(ms) || ms <= 0) return CLAUDE_RETRY_AFTER_DEFAULT_MS;
  return Math.min(ms, CLAUDE_RETRY_AFTER_MAX_MS);
};

const SIGNAL_WINDOWS = [
  { prefix: '5h', id: 'five-hour', labelKey: 'claude_quota.five_hour', period: 'five_hour' },
  { prefix: '7d', id: 'seven-day', labelKey: 'claude_quota.seven_day', period: 'seven_day' },
  {
    prefix: '7d_oi',
    id: 'seven-day-fable',
    labelKey: 'claude_quota.seven_day_fable',
    period: 'seven_day',
  },
] as const;

const toNumber = (value: unknown): number | null => {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
};

/**
 * Windows rebuilt from the rate-limit headers the proxy kept from the last
 * reply it relayed for this credential (`quota.signals` on /credentials).
 * Null when the proxy has nothing for it (no reply since it last restarted).
 */
export const buildClaudeSignalWindows = (
  file: AuthFileItem,
  t: TFunction
): { windows: ClaudeQuotaWindow[]; observedAtMs: number | null } | null => {
  const quota = file['quota'];
  if (!quota || typeof quota !== 'object') return null;
  const { signals, observed_at: observedAt } = quota as Record<string, unknown>;
  if (!signals || typeof signals !== 'object') return null;
  const lookup = new Map(
    Object.entries(signals as Record<string, unknown>).map(([k, v]) => [k.toLowerCase(), v])
  );
  const signal = (prefix: string, field: string) =>
    toNumber(lookup.get(`anthropic-ratelimit-unified-${prefix}-${field}`));

  const windows: ClaudeQuotaWindow[] = [];
  for (const { prefix, id, labelKey, period } of SIGNAL_WINDOWS) {
    const utilization = signal(prefix, 'utilization');
    if (utilization === null) continue;
    const resetSec = signal(prefix, 'reset');
    windows.push({
      id,
      label: t(labelKey),
      labelKey,
      usedPercent: utilization * 100,
      resetLabel: formatUnixSeconds(resetSec),
      resetAtMs: resetSec ? resetSec * 1000 : null,
      periodHours: claudePeriodHours(period),
    });
  }
  if (windows.length === 0) return null;
  const observedAtMs = typeof observedAt === 'string' ? Date.parse(observedAt) : NaN;
  return { windows, observedAtMs: Number.isFinite(observedAtMs) ? observedAtMs : null };
};
