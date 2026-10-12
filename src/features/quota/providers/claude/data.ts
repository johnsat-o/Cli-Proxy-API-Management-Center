/**
 * Claude 额度数据层：用量窗口 + 套餐 + 额外用量。
 * React-free / SCSS-free —— 由 tests/claudeFableQuota.test.ts 直接消费。
 */

import type { TFunction } from 'i18next';
import type {
  AuthFileItem,
  ClaudeExtraUsage,
  ClaudeProfileResponse,
  ClaudeQuotaNotice,
  ClaudeQuotaState,
  ClaudeQuotaWindow,
  ClaudeUsageWindow,
  ClaudeUsagePayload,
} from '@/types';
import { apiCallApi, getApiCallErrorMessage } from '@/services/api';
import {
  parseAnthropicResetGrantStatus,
  type AnthropicResetGrantStatus,
} from '@/services/api/claudeResetGrants';
import {
  CLAUDE_PROFILE_URL,
  CLAUDE_USAGE_WITH_GRANTS_URL,
  CLAUDE_REQUEST_HEADERS,
  CLAUDE_USAGE_WINDOW_KEYS,
  claudePeriodHours,
  normalizeNumberValue,
  normalizeStringValue,
  parseClaudeUsagePayload,
  formatQuotaResetTime,
  resolveResetMs,
  createStatusError,
  isClaudeFile,
  isDisabledAuthFile,
} from '@/utils/quota';
import { normalizeAuthIndex } from '@/utils/authIndex';
import type { QuotaFetchOptions, QuotaProviderData } from '../types';
import {
  CLAUDE_PLAN_CACHE_TTL_MS,
  CLAUDE_USAGE_CACHE_TTL_MS,
  buildClaudeSignalWindows,
  parseRetryAfterMs,
  readClaudeUsageCache,
  writeClaudeUsageCache,
} from './usageCache';

export type ClaudeQuotaData = {
  windows: ClaudeQuotaWindow[];
  extraUsage?: ClaudeExtraUsage | null;
  planType?: string | null;
  /** Set when Anthropic rate-limited the lookup and older numbers are shown. */
  notice?: ClaudeQuotaNotice;
  /** Numbers came from the cache or the proxy, not a live lookup. */
  stale?: boolean;
  /** Banked reset grants carried by the usage payload; null when absent or malformed. */
  resetGrants?: AnthropicResetGrantStatus | null;
  /** The lookup's error text when there was nothing to fall back to. */
  error?: string;
};

const findFableUsageLimit = (payload: ClaudeUsagePayload) => {
  if (!Array.isArray(payload.limits)) return null;

  const candidates = payload.limits.filter((limit) => {
    const kind = (normalizeStringValue(limit?.kind) ?? '').trim().toLowerCase();
    const modelName = (normalizeStringValue(limit?.scope?.model?.display_name) ?? '')
      .trim()
      .toLowerCase();
    const isFable = modelName === 'fable' || modelName === 'fable 5';
    return kind === 'weekly_scoped' && isFable && normalizeNumberValue(limit?.percent) !== null;
  });

  return candidates.find((limit) => limit.is_active === true) ?? candidates[0] ?? null;
};

const isDollarDenominatedWindow = (window: ClaudeUsageWindow) =>
  normalizeNumberValue(window.limit_dollars) !== null ||
  normalizeNumberValue(window.used_dollars) !== null ||
  normalizeNumberValue(window.remaining_dollars) !== null;

export const buildClaudeQuotaWindows = (
  payload: ClaudeUsagePayload,
  t: TFunction
): ClaudeQuotaWindow[] => {
  const windows: ClaudeQuotaWindow[] = [];
  const fableLimit = findFableUsageLimit(payload);

  for (const { key, id, labelKey } of CLAUDE_USAGE_WINDOW_KEYS) {
    const window = payload[key as keyof ClaudeUsagePayload];
    if (!window || typeof window !== 'object' || !('utilization' in window)) continue;
    const typedWindow = window as ClaudeUsageWindow;
    const isCreditPool = key === 'iguana_necktie' && isDollarDenominatedWindow(typedWindow);
    if (key === 'iguana_necktie' && fableLimit && !isCreditPool) continue;
    if (isCreditPool) {
      windows.push({
        id: 'cloud-session-credits',
        label: t('claude_quota.cloud_session_credits'),
        labelKey: 'claude_quota.cloud_session_credits',
        usedPercent: normalizeNumberValue(typedWindow.utilization),
        resetLabel: formatQuotaResetTime(typedWindow.resets_at ?? undefined),
        resetAtMs: resolveResetMs([typedWindow.resets_at]),
        periodHours: null,
      });
      continue;
    }
    const usedPercent = normalizeNumberValue(typedWindow.utilization);
    const resetLabel = formatQuotaResetTime(typedWindow.resets_at ?? undefined);
    windows.push({
      id,
      label: t(labelKey),
      labelKey,
      usedPercent,
      resetLabel,
      // Claude states the period nowhere in the payload, so it comes from the
      // key: `five_hour` is the rolling window, everything else is weekly.
      resetAtMs: resolveResetMs([typedWindow.resets_at]),
      periodHours: claudePeriodHours(key),
    });
  }

  if (fableLimit) {
    const usedPercent = normalizeNumberValue(fableLimit.percent);
    if (usedPercent !== null) {
      windows.push({
        id: 'seven-day-fable',
        label: t('claude_quota.seven_day_fable'),
        labelKey: 'claude_quota.seven_day_fable',
        usedPercent,
        resetLabel: formatQuotaResetTime(fableLimit.resets_at ?? undefined),
        // `weekly_scoped` is a 7-day window by definition, so the timeline can
        // place this row alongside the ones derived from the named keys.
        resetAtMs: resolveResetMs([fableLimit.resets_at]),
        periodHours: claudePeriodHours('seven_day'),
      });
    }
  }

  return windows;
};

const normalizeFlagValue = (value: unknown): boolean | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const trimmed = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'y', 'on'].includes(trimmed)) return true;
    if (['false', '0', 'no', 'n', 'off'].includes(trimmed)) return false;
  }
  return undefined;
};

const parseClaudeProfilePayload = (payload: unknown): ClaudeProfileResponse | null => {
  if (payload === undefined || payload === null) return null;
  if (typeof payload === 'string') {
    const trimmed = payload.trim();
    if (!trimmed) return null;
    try {
      return JSON.parse(trimmed) as ClaudeProfileResponse;
    } catch {
      return null;
    }
  }
  if (typeof payload === 'object') {
    return payload as ClaudeProfileResponse;
  }
  return null;
};

export const resolveClaudePlanType = (profile: ClaudeProfileResponse | null): string | null => {
  if (!profile) return null;

  const organizationType = normalizeStringValue(
    profile.organization?.organization_type
  )?.toLowerCase();
  const subscriptionStatus = normalizeStringValue(
    profile.organization?.subscription_status
  )?.toLowerCase();

  if (organizationType === 'claude_team' && subscriptionStatus === 'active') {
    return 'plan_team';
  }

  // Account flags include personal subscriptions even for a Team-scoped token.
  const hasClaudeMax = normalizeFlagValue(profile.account?.has_claude_max);
  if (hasClaudeMax) return 'plan_max';

  const hasClaudePro = normalizeFlagValue(profile.account?.has_claude_pro);
  if (hasClaudePro) return 'plan_pro';

  if (hasClaudeMax === false && hasClaudePro === false) return 'plan_free';

  return null;
};

const quotaFromPayload = (
  payload: ClaudeUsagePayload,
  planType: string | null | undefined,
  t: TFunction
): ClaudeQuotaData => ({
  windows: buildClaudeQuotaWindows(payload, t),
  extraUsage: payload.extra_usage,
  planType: planType ?? null,
  resetGrants: parseAnthropicResetGrantStatus(payload.cedar_ember),
});

/** The cached usage when it is young enough to skip the network, else null. */
export const readFreshClaudeQuota = (
  file: AuthFileItem,
  t: TFunction,
  now = Date.now()
): ClaudeQuotaData | null => {
  const authIndex = normalizeAuthIndex(file['auth_index'] ?? file.authIndex);
  if (!authIndex) return null;
  const cached = readClaudeUsageCache(authIndex);
  if (!cached?.usage || !cached.usageAt || now - cached.usageAt >= CLAUDE_USAGE_CACHE_TTL_MS) {
    return null;
  }
  return { ...quotaFromPayload(cached.usage, cached.planType, t), stale: true };
};

/**
 * One path for page load, "Refresh all credentials" and per-card refresh.
 * Without `force` a usage payload younger than 120 s is reused with no call.
 * A 429 falls back to the cached usage, then to the proxy's relayed headers.
 */
const fetchClaudeQuota = async (
  file: AuthFileItem,
  t: TFunction,
  options: QuotaFetchOptions = {}
): Promise<ClaudeQuotaData> => {
  const rawAuthIndex = file['auth_index'] ?? file.authIndex;
  const authIndex = normalizeAuthIndex(rawAuthIndex);
  if (!authIndex) {
    throw new Error(t('claude_quota.missing_auth_index'));
  }

  if (!options.force) {
    const fresh = readFreshClaudeQuota(file, t);
    if (fresh) return fresh;
  }

  const cached = readClaudeUsageCache(authIndex);
  const planIsFresh =
    cached?.planAt !== undefined && Date.now() - cached.planAt < CLAUDE_PLAN_CACHE_TTL_MS;

  const [usageResult, profileResult] = await Promise.allSettled([
    apiCallApi.request({
      authIndex,
      method: 'GET',
      url: CLAUDE_USAGE_WITH_GRANTS_URL,
      header: { ...CLAUDE_REQUEST_HEADERS },
    }),
    planIsFresh
      ? Promise.resolve(null)
      : apiCallApi.request({
          authIndex,
          method: 'GET',
          url: CLAUDE_PROFILE_URL,
          header: { ...CLAUDE_REQUEST_HEADERS },
        }),
  ]);

  if (usageResult.status === 'rejected') {
    throw usageResult.reason;
  }

  const result = usageResult.value;
  const now = Date.now();

  let planType = cached?.planType ?? null;
  const profile = profileResult.status === 'fulfilled' ? profileResult.value : null;
  if (profile && profile.statusCode >= 200 && profile.statusCode < 300) {
    planType = resolveClaudePlanType(parseClaudeProfilePayload(profile.body ?? profile.bodyText));
    writeClaudeUsageCache(authIndex, { planType, planAt: now });
  }

  if (result.statusCode === 429) {
    const retry = {
      retryAtMs: now + parseRetryAfterMs(result.header, now),
      autoRetry: !options.autoRetry,
    };
    if (cached?.usage) {
      return {
        ...quotaFromPayload(cached.usage, planType, t),
        stale: true,
        notice: { source: 'cache', asOfMs: cached.usageAt ?? null, ...retry },
      };
    }
    const fromSignals = buildClaudeSignalWindows(file, t);
    if (fromSignals) {
      return {
        windows: fromSignals.windows,
        planType,
        stale: true,
        notice: { source: 'proxy', asOfMs: fromSignals.observedAtMs, ...retry },
      };
    }
    return {
      windows: [],
      stale: true,
      notice: { source: 'none', asOfMs: null, ...retry },
      error: getApiCallErrorMessage(result),
    };
  }

  if (result.statusCode < 200 || result.statusCode >= 300) {
    throw createStatusError(getApiCallErrorMessage(result), result.statusCode);
  }

  const payload = parseClaudeUsagePayload(result.body ?? result.bodyText);
  if (!payload) {
    throw new Error(t('claude_quota.empty_windows'));
  }

  writeClaudeUsageCache(authIndex, { usage: payload, usageAt: now });
  return quotaFromPayload(payload, planType, t);
};

export const CLAUDE_CONFIG: QuotaProviderData<ClaudeQuotaState, ClaudeQuotaData> = {
  type: 'claude',
  i18nPrefix: 'claude_quota',
  filterFn: (file) => isClaudeFile(file) && !isDisabledAuthFile(file),
  fetchQuota: fetchClaudeQuota,
  storeSelector: (state) => state.claudeQuota,
  storeSetter: 'setClaudeQuota',
  buildLoadingState: () => ({ status: 'loading', windows: [] }),
  // A 429 with no cached usage and no proxy signals renders as the red error.
  buildSuccessState: (data) =>
    data.notice?.source === 'none'
      ? {
          status: 'error',
          windows: [],
          error: data.error,
          errorStatus: 429,
          notice: data.notice,
          stale: true,
        }
      : {
          status: 'success',
          windows: data.windows,
          extraUsage: data.extraUsage,
          planType: data.planType,
          notice: data.notice,
          stale: data.stale,
          resetGrants: data.resetGrants ?? null,
        },
  buildErrorState: (message, status) => ({
    status: 'error',
    windows: [],
    error: message,
    errorStatus: status,
  }),
};
