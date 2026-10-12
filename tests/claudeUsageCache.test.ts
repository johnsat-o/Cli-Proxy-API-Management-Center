import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { TFunction } from 'i18next';
import {
  CLAUDE_CONFIG,
  overlayProxySignals,
  readFreshClaudeQuota,
} from '@/features/quota/providers/claude/data';
import {
  buildClaudeSignalWindows,
  parseRetryAfterMs,
  writeClaudeUsageCache,
} from '@/features/quota/providers/claude/usageCache';
import { apiCallApi } from '@/services/api/apiCall';
import type { AuthFileItem } from '@/types';

const t = ((key: string) => key) as unknown as TFunction;

const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => store.set(k, v),
  removeItem: (k: string) => store.delete(k),
};

const file = (extra: Record<string, unknown> = {}): AuthFileItem =>
  ({ name: 'claude-a.json', type: 'claude', auth_index: 'abc', ...extra }) as AuthFileItem;

describe('Claude usage cache', () => {
  beforeEach(() => store.clear());

  test('reuses usage younger than 120 s and drops older usage', () => {
    const now = 1_000_000_000;
    writeClaudeUsageCache('abc', {
      usage: { five_hour: { utilization: 26, resets_at: null } },
      usageAt: now - 119_000,
      planType: 'plan_max',
    });
    const fresh = readFreshClaudeQuota(file(), t, now);
    expect(fresh?.windows[0]).toMatchObject({ id: 'five-hour', usedPercent: 26 });
    expect(fresh?.planType).toBe('plan_max');
    expect(readFreshClaudeQuota(file(), t, now + 2_000)).toBeNull();
  });
});

describe('Retry-After', () => {
  test('reads seconds, caps at 300 s, defaults to 60 s', () => {
    expect(parseRetryAfterMs({ 'Retry-After': ['42'] })).toBe(42_000);
    expect(parseRetryAfterMs({ 'retry-after': ['271'] })).toBe(271_000);
    expect(parseRetryAfterMs({ 'Retry-After': ['900'] })).toBe(300_000);
    expect(parseRetryAfterMs({})).toBe(60_000);
  });
});

describe('proxy signal fallback', () => {
  test('builds used-share windows from the relayed rate-limit headers', () => {
    const result = buildClaudeSignalWindows(
      file({
        quota: {
          observed_at: '2026-10-11T22:43:52-05:00',
          signals: {
            'Anthropic-Ratelimit-Unified-5h-Utilization': '0.26',
            'Anthropic-Ratelimit-Unified-5h-Reset': '1791786600',
            'Anthropic-Ratelimit-Unified-7d-Utilization': '0.4',
            'Anthropic-Ratelimit-Unified-7d_oi-Utilization': '0.1',
          },
        },
      }),
      t
    );
    expect(result?.windows.map((w) => [w.id, w.usedPercent])).toEqual([
      ['five-hour', 26],
      ['seven-day', 40],
      ['seven-day-fable', 10],
    ]);
    expect(result?.windows[0].resetAtMs).toBe(1791786600_000);
    expect(result?.observedAtMs).toBe(Date.parse('2026-10-11T22:43:52-05:00'));
  });

  test('is null when the proxy has no signals for the credential', () => {
    expect(buildClaudeSignalWindows(file(), t)).toBeNull();
    expect(buildClaudeSignalWindows(file({ quota: { signals: {} } }), t)).toBeNull();
  });

  test('a 429 with nothing to show renders as the error state', () => {
    const notice = {
      source: 'none',
      asOfMs: null,
      retryAtMs: 1,
      autoRetry: true,
      attempt: 1,
    } as const;
    expect(CLAUDE_CONFIG.buildSuccessState({ windows: [], notice, error: '429 x' })).toMatchObject({
      status: 'error',
      errorStatus: 429,
      error: '429 x',
    });
  });
});

describe('banked resets ride along with the usage lookup', () => {
  const originalRequest = apiCallApi.request;
  afterEach(() => {
    apiCallApi.request = originalRequest;
    store.clear();
  });

  const grant = { id: 'launch', resets_total: 1, resets_left: 1, usable_now: true };
  const payload = {
    five_hour: { utilization: 34, resets_at: null },
    cedar_ember: { eligible: true, at_limit: false, grants: [grant] },
  };

  test('one call asks for cedar_ember and the result carries the grants', async () => {
    const urls: string[] = [];
    apiCallApi.request = async (request) => {
      urls.push(request.url);
      return { statusCode: 200, body: payload, bodyText: '', header: {} };
    };
    const data = await CLAUDE_CONFIG.fetchQuota(file(), t, { force: true });
    expect(urls.filter((u) => u.includes('/api/oauth/usage'))).toEqual([
      'https://api.anthropic.com/api/oauth/usage?cedar_ember=1',
    ]);
    expect(data.resetGrants?.grants.map((g) => [g.id, g.resetsLeft])).toEqual([['launch', 1]]);
    expect(CLAUDE_CONFIG.buildSuccessState(data).resetGrants?.grants).toHaveLength(1);
  });

  test('a cached payload keeps its grants; a payload without the block gives null', () => {
    const now = 5_000_000;
    writeClaudeUsageCache('abc', { usage: payload, usageAt: now });
    expect(readFreshClaudeQuota(file(), t, now)?.resetGrants?.grants[0].id).toBe('launch');
    writeClaudeUsageCache('abc', { usage: { five_hour: { utilization: 1, resets_at: null } } });
    expect(readFreshClaudeQuota(file(), t, now)?.resetGrants).toBeNull();
  });
});

describe('rate-limited fallback', () => {
  const originalRequest = apiCallApi.request;
  afterEach(() => {
    apiCallApi.request = originalRequest;
    store.clear();
  });

  const signals = {
    observed_at: '2026-10-12T05:00:00-05:00',
    signals: {
      'Anthropic-Ratelimit-Unified-5h-Utilization': '0.4',
      'Anthropic-Ratelimit-Unified-5h-Reset': '1791804600',
    },
  };
  const cachedUsage = {
    five_hour: { utilization: 30, resets_at: null },
    seven_day: { utilization: 44, resets_at: null },
    limits: [
      {
        kind: 'weekly_scoped',
        percent: 68,
        is_active: true,
        scope: { model: { display_name: 'Fable 5' } },
      },
    ],
  };

  test("keeps every cached bar and lays the proxy's newer numbers over it", () => {
    writeClaudeUsageCache('abc', {
      usage: cachedUsage,
      usageAt: Date.parse('2026-10-12T04:00:00-05:00'),
    });
    const cached = readFreshClaudeQuota(file(), t, Date.parse('2026-10-12T04:00:30-05:00'))!;
    const overlaid = overlayProxySignals(
      cached.windows,
      Date.parse('2026-10-12T04:00:00-05:00'),
      buildClaudeSignalWindows(file({ quota: signals }), t)
    )!;
    expect(overlaid.windows.map((w) => [w.id, w.usedPercent])).toEqual([
      ['five-hour', 40],
      ['seven-day', 44],
      ['seven-day-fable', 68],
    ]);
    expect(overlaid.observedAtMs).toBe(Date.parse('2026-10-12T05:00:00-05:00'));
    // Older proxy headers change nothing.
    expect(
      overlayProxySignals(
        cached.windows,
        Date.parse('2026-10-12T06:00:00-05:00'),
        buildClaudeSignalWindows(file({ quota: signals }), t)
      )
    ).toBeNull();
  });

  test('a 429 counts attempts and stops retrying after the third', async () => {
    apiCallApi.request = async () => ({
      statusCode: 429,
      body: null,
      bodyText: '',
      header: { 'Retry-After': ['30'] },
    });
    writeClaudeUsageCache('abc', { usage: cachedUsage, usageAt: 1 });
    const first = await CLAUDE_CONFIG.fetchQuota(file({ quota: signals }), t, { force: true });
    expect(first.notice).toMatchObject({ source: 'proxy', autoRetry: true, attempt: 1 });
    expect(first.windows.map((w) => w.id)).toEqual(['five-hour', 'seven-day', 'seven-day-fable']);
    const third = await CLAUDE_CONFIG.fetchQuota(file(), t, {
      force: true,
      autoRetry: true,
      attempt: 2,
    });
    expect(third.notice).toMatchObject({ source: 'cache', autoRetry: true, attempt: 3 });
    const fourth = await CLAUDE_CONFIG.fetchQuota(file(), t, {
      force: true,
      autoRetry: true,
      attempt: 3,
    });
    expect(fourth.notice).toMatchObject({ autoRetry: false, attempt: 4 });
  });
});
