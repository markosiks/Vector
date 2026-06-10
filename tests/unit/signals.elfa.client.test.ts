import { describe, expect, test } from 'bun:test';

import {
  createElfaClient,
  ELFA_TIME_WINDOW,
  ELFA_TRENDING_PATH,
  ElfaClientError,
  ElfaHttpError,
  ElfaParseError,
  ElfaPaymentRequiredError,
  ElfaRateLimitError,
  ElfaTimeoutError,
} from '@/lib/signals/elfa/client';

/**
 * Unit: the single-endpoint Elfa client. Transport is injected (`fetchImpl`,
 * `now`), so these exercise the real parse/normalize/error logic with no
 * network. The contract under test: a clean response normalizes to a typed,
 * `origin: 'live'` snapshot; every other reachable outcome maps to exactly one
 * typed error and the client never returns guessed or partial data.
 */

const ENDPOINT = 'https://api.elfa.test';

/** A `fetchImpl` that returns one canned `Response` and records the call. */
function stubFetch(response: Response): {
  fetchImpl: typeof fetch;
  calls: { url: string; init: RequestInit | undefined }[];
} {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('elfa client — happy path', () => {
  test('normalizes a top-level array into a typed live snapshot', async () => {
    const { fetchImpl } = stubFetch(
      jsonResponse([
        {
          symbol: 'BTC',
          tokenAddress: '0xabc',
          sentiment: '0.62',
          mentions: '1840',
          mindshare: '0.31',
        },
      ]),
    );
    const client = createElfaClient({ apiKey: 'k', endpoint: ENDPOINT, fetchImpl, now: () => 42 });
    const signal = await client.fetchSignal();

    expect(signal).toEqual({
      source: 'elfa',
      origin: 'live',
      endpoint: ELFA_TRENDING_PATH,
      fetchedAtMs: 42,
      sentiments: [
        {
          symbol: 'BTC',
          tokenAddress: '0xabc',
          sentiment: '0.62',
          mentions: '1840',
          mindshare: '0.31',
        },
      ],
    });
  });

  test('unwraps the `{ data: [...] }` envelope and key aliases', async () => {
    const { fetchImpl } = stubFetch(
      jsonResponse({
        data: [{ tokenSymbol: 'PEPE', sentimentScore: -0.25, token_address: '0xdef' }],
      }),
    );
    const client = createElfaClient({ apiKey: 'k', endpoint: ENDPOINT, fetchImpl });
    const signal = await client.fetchSignal();
    expect(signal.sentiments).toEqual([
      { symbol: 'PEPE', tokenAddress: '0xdef', sentiment: '-0.25' },
    ]);
  });

  test('unwraps a nested `{ data: { items: [...] } }` envelope', async () => {
    const { fetchImpl } = stubFetch(
      jsonResponse({ data: { items: [{ token: 'SOL', score: 0.1 }] } }),
    );
    const client = createElfaClient({ apiKey: 'k', endpoint: ENDPOINT, fetchImpl });
    const signal = await client.fetchSignal();
    expect(signal.sentiments).toEqual([{ symbol: 'SOL', sentiment: '0.1' }]);
  });

  // Regression: live v2 shape (2026) — `{ data: { data: [...] } }` envelope with
  // `current_count`/`change_percent` rows (no explicit sentiment on this tier).
  test('unwraps the live `{ data: { data: [...] } }` envelope and momentum aliases', async () => {
    const { fetchImpl } = stubFetch(
      jsonResponse({
        success: true,
        data: {
          total: 50,
          page: 1,
          pageSize: 50,
          data: [
            { token: 'btc', current_count: 607, previous_count: 628, change_percent: -3.34 },
            { token: 'spcx', current_count: 132, previous_count: 103, change_percent: 28.16 },
          ],
        },
      }),
    );
    const client = createElfaClient({ apiKey: 'k', endpoint: ENDPOINT, fetchImpl });
    const signal = await client.fetchSignal();
    expect(signal.sentiments).toEqual([
      { symbol: 'btc', sentiment: '-3.34', mentions: '607' },
      { symbol: 'spcx', sentiment: '28.16', mentions: '132' },
    ]);
  });

  test('sends the key in the `x-elfa-api-key` header, never in the URL, GET method', async () => {
    const { fetchImpl, calls } = stubFetch(jsonResponse([]));
    const client = createElfaClient({ apiKey: 'super-secret', endpoint: ENDPOINT, fetchImpl });
    await client.fetchSignal();

    const { url, init } = calls[0]!;
    expect(url).toBe(`${ENDPOINT}${ELFA_TRENDING_PATH}?timeWindow=${ELFA_TIME_WINDOW}`);
    expect(url).not.toContain('super-secret');
    const headers = init?.headers as Record<string, string>;
    expect(headers['x-elfa-api-key']).toBe('super-secret');
    expect(init?.method).toBe('GET');
  });
});

describe('elfa client — value normalization', () => {
  test('keeps zero, negative, and extreme finite sentiments as exact strings', async () => {
    const { fetchImpl } = stubFetch(
      jsonResponse([
        { symbol: 'A', sentiment: 0 },
        { symbol: 'B', sentiment: '-0.000001' },
        { symbol: 'C', sentiment: '99999999999999999999' },
      ]),
    );
    const client = createElfaClient({ apiKey: 'k', endpoint: ENDPOINT, fetchImpl });
    const signal = await client.fetchSignal();
    expect(signal.sentiments.map((s) => s.sentiment)).toEqual([
      '0',
      '-0.000001',
      '99999999999999999999',
    ]);
  });

  test('preserves unicode symbols', async () => {
    const { fetchImpl } = stubFetch(jsonResponse([{ symbol: '🦄/USD', sentiment: '1' }]));
    const client = createElfaClient({ apiKey: 'k', endpoint: ENDPOINT, fetchImpl });
    const signal = await client.fetchSignal();
    expect(signal.sentiments[0]?.symbol).toBe('🦄/USD');
  });

  test('drops rows with no usable sentiment value, keeps the valid ones', async () => {
    const { fetchImpl } = stubFetch(
      jsonResponse([
        { symbol: 'GOOD', sentiment: '0.1' },
        { symbol: 'NO_VALUE' },
        { symbol: 'NAN', sentiment: 'not-a-number' },
        { symbol: 'INF', sentiment: 'Infinity' },
        { symbol: 'ALSO_GOOD', score: '0.2' },
      ]),
    );
    const client = createElfaClient({ apiKey: 'k', endpoint: ENDPOINT, fetchImpl });
    const signal = await client.fetchSignal();
    expect(signal.sentiments.map((s) => s.symbol)).toEqual(['GOOD', 'ALSO_GOOD']);
  });

  test('caps the number of normalized rows', async () => {
    const rows = Array.from({ length: 200 }, (_, i) => ({ symbol: `T${i}`, sentiment: String(i) }));
    const { fetchImpl } = stubFetch(jsonResponse(rows));
    const client = createElfaClient({ apiKey: 'k', endpoint: ENDPOINT, fetchImpl, maxRows: 5 });
    const signal = await client.fetchSignal();
    expect(signal.sentiments).toHaveLength(5);
  });
});

describe('elfa client — typed failures', () => {
  test('429 → ElfaRateLimitError with parsed Retry-After', async () => {
    const { fetchImpl } = stubFetch(
      new Response('{}', { status: 429, headers: { 'retry-after': '2' } }),
    );
    const client = createElfaClient({ apiKey: 'k', endpoint: ENDPOINT, fetchImpl });
    const err = await client.fetchSignal().catch((e) => e);
    expect(err).toBeInstanceOf(ElfaRateLimitError);
    expect((err as ElfaRateLimitError).retryAfterMs).toBe(2000);
  });

  test('402 → ElfaPaymentRequiredError (x402 path unsatisfied)', async () => {
    const { fetchImpl } = stubFetch(new Response('{}', { status: 402 }));
    const client = createElfaClient({ apiKey: 'k', endpoint: ENDPOINT, fetchImpl });
    await expect(client.fetchSignal()).rejects.toBeInstanceOf(ElfaPaymentRequiredError);
  });

  test('5xx → ElfaHttpError carrying the status', async () => {
    const { fetchImpl } = stubFetch(new Response('boom', { status: 503 }));
    const client = createElfaClient({ apiKey: 'k', endpoint: ENDPOINT, fetchImpl });
    const err = await client.fetchSignal().catch((e) => e);
    expect(err).toBeInstanceOf(ElfaHttpError);
    expect((err as ElfaHttpError).status).toBe(503);
  });

  test('invalid JSON → ElfaParseError', async () => {
    const { fetchImpl } = stubFetch(new Response('{ not json', { status: 200 }));
    const client = createElfaClient({ apiKey: 'k', endpoint: ENDPOINT, fetchImpl });
    await expect(client.fetchSignal()).rejects.toBeInstanceOf(ElfaParseError);
  });

  test('a JSON shape with no rows array → ElfaParseError', async () => {
    const { fetchImpl } = stubFetch(jsonResponse({ unexpected: true }));
    const client = createElfaClient({ apiKey: 'k', endpoint: ENDPOINT, fetchImpl });
    await expect(client.fetchSignal()).rejects.toBeInstanceOf(ElfaParseError);
  });

  test('an over-cap Content-Length → ElfaParseError before buffering', async () => {
    const { fetchImpl } = stubFetch(
      new Response('[]', { status: 200, headers: { 'content-length': String(50 * 1024 * 1024) } }),
    );
    const client = createElfaClient({ apiKey: 'k', endpoint: ENDPOINT, fetchImpl });
    await expect(client.fetchSignal()).rejects.toBeInstanceOf(ElfaParseError);
  });

  test('a generic network failure → ElfaClientError (not a leaked raw error)', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('connection refused');
    }) as unknown as typeof fetch;
    const client = createElfaClient({ apiKey: 'k', endpoint: ENDPOINT, fetchImpl });
    const err = await client.fetchSignal().catch((e) => e);
    expect(err).toBeInstanceOf(ElfaClientError);
  });

  test('an abort (timeout) → ElfaTimeoutError', async () => {
    const fetchImpl = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal;
        signal?.addEventListener('abort', () => {
          const e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        });
      })) as unknown as typeof fetch;
    const client = createElfaClient({ apiKey: 'k', endpoint: ENDPOINT, fetchImpl, timeoutMs: 5 });
    const err = await client.fetchSignal().catch((e) => e);
    expect(err).toBeInstanceOf(ElfaTimeoutError);
    expect((err as ElfaTimeoutError).timeoutMs).toBe(5);
  });
});

describe('elfa client — network hardening (audit regressions)', () => {
  test('refuses to follow redirects (redirect: "error") so the key cannot leak cross-origin', async () => {
    const { fetchImpl, calls } = stubFetch(jsonResponse([]));
    const client = createElfaClient({ apiKey: 'k', endpoint: ENDPOINT, fetchImpl });
    await client.fetchSignal();
    expect(calls[0]!.init?.redirect).toBe('error');
  });

  test('a slow-drip body (headers fast, body never completes) → ElfaTimeoutError', async () => {
    const fetchImpl = ((_url: string, init?: RequestInit) => {
      const sig = init?.signal;
      const res = {
        status: 200,
        ok: true,
        headers: { get: () => null },
        text: () =>
          new Promise<string>((_resolve, reject) => {
            sig?.addEventListener('abort', () => {
              const e = new Error('aborted');
              e.name = 'AbortError';
              reject(e);
            });
          }),
      };
      return Promise.resolve(res);
    }) as unknown as typeof fetch;

    const client = createElfaClient({ apiKey: 'k', endpoint: ENDPOINT, fetchImpl, timeoutMs: 5 });
    const err = await client.fetchSignal().catch((e) => e);
    expect(err).toBeInstanceOf(ElfaTimeoutError);
  });

  test('caps how many raw rows it scans: usable rows past the scan cap are not reached', async () => {
    const rows: unknown[] = Array.from({ length: 6_000 }, () => ({}));
    rows.push({ symbol: 'LATE', sentiment: '0.9' });
    const { fetchImpl } = stubFetch(jsonResponse(rows));
    const client = createElfaClient({ apiKey: 'k', endpoint: ENDPOINT, fetchImpl });
    const out = await client.fetchSignal();
    expect(out.sentiments).toHaveLength(0);
  });

  test('Retry-After is clamped: negative/huge/non-numeric values are sanitized', async () => {
    const cases: [string, number | undefined][] = [
      ['2', 2_000],
      ['-5', undefined],
      ['0', undefined],
      ['999999999', 5 * 60 * 1_000],
      ['Mon, 01 Jan 2030 00:00:00 GMT', undefined],
    ];
    for (const [header, expected] of cases) {
      const { fetchImpl } = stubFetch(
        new Response('{}', { status: 429, headers: { 'retry-after': header } }),
      );
      const client = createElfaClient({ apiKey: 'k', endpoint: ENDPOINT, fetchImpl });
      const err = await client.fetchSignal().catch((e) => e);
      expect(err).toBeInstanceOf(ElfaRateLimitError);
      expect((err as ElfaRateLimitError).retryAfterMs).toBe(expected);
    }
  });
});
