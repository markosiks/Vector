import { describe, expect, test } from 'bun:test';

import {
  createNansenClient,
  NANSEN_NETFLOWS_PATH,
  NansenClientError,
  NansenHttpError,
  NansenParseError,
  NansenRateLimitError,
  NansenTimeoutError,
} from '@/lib/signals/nansen/client';

/**
 * Unit: the single-endpoint Nansen client. Transport is injected (`fetchImpl`,
 * `now`), so these exercise the real parse/normalize/error logic with no
 * network. The contract under test: a clean response normalizes to a typed
 * snapshot; every other reachable outcome maps to exactly one typed error and
 * the client never returns guessed or partial data.
 */

const ENDPOINT = 'https://api.nansen.test';

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

describe('nansen client — happy path', () => {
  test('normalizes a top-level array into a typed snapshot', async () => {
    const { fetchImpl } = stubFetch(
      jsonResponse([
        { chain: 'ethereum', symbol: 'WETH', tokenAddress: '0xabc', netflowUsd: '1500000.5' },
      ]),
    );
    const client = createNansenClient({
      apiKey: 'k',
      endpoint: ENDPOINT,
      fetchImpl,
      now: () => 42,
    });
    const signal = await client.fetchSignal();

    expect(signal).toEqual({
      source: 'nansen',
      endpoint: NANSEN_NETFLOWS_PATH,
      fetchedAtMs: 42,
      netflows: [
        { chain: 'ethereum', tokenAddress: '0xabc', symbol: 'WETH', netflowUsd: '1500000.5' },
      ],
    });
  });

  test('unwraps the `{ data: [...] }` envelope and key aliases', async () => {
    const { fetchImpl } = stubFetch(
      jsonResponse({ data: [{ tokenSymbol: 'PEPE', netflow: -250, token_address: '0xdef' }] }),
    );
    const client = createNansenClient({ apiKey: 'k', endpoint: ENDPOINT, fetchImpl });
    const signal = await client.fetchSignal();
    expect(signal.netflows).toEqual([
      { tokenAddress: '0xdef', symbol: 'PEPE', netflowUsd: '-250' },
    ]);
  });

  test('sends the key in the `apiKey` header, never in the URL', async () => {
    const { fetchImpl, calls } = stubFetch(jsonResponse([]));
    const client = createNansenClient({ apiKey: 'super-secret', endpoint: ENDPOINT, fetchImpl });
    await client.fetchSignal();

    const { url, init } = calls[0]!;
    expect(url).toBe(`${ENDPOINT}${NANSEN_NETFLOWS_PATH}`);
    expect(url).not.toContain('super-secret');
    const headers = init?.headers as Record<string, string>;
    expect(headers.apiKey).toBe('super-secret');
    expect(init?.method).toBe('POST');
  });
});

describe('nansen client — value normalization', () => {
  test('keeps zero, negative, and extreme finite values as exact strings', async () => {
    const { fetchImpl } = stubFetch(
      jsonResponse([
        { symbol: 'A', netflowUsd: 0 },
        { symbol: 'B', netflowUsd: '-0.000001' },
        { symbol: 'C', netflowUsd: '99999999999999999999' },
      ]),
    );
    const client = createNansenClient({ apiKey: 'k', endpoint: ENDPOINT, fetchImpl });
    const signal = await client.fetchSignal();
    expect(signal.netflows.map((n) => n.netflowUsd)).toEqual([
      '0',
      '-0.000001',
      '99999999999999999999',
    ]);
  });

  test('preserves unicode symbols', async () => {
    const { fetchImpl } = stubFetch(jsonResponse([{ symbol: '🦄/USD', netflowUsd: '1' }]));
    const client = createNansenClient({ apiKey: 'k', endpoint: ENDPOINT, fetchImpl });
    const signal = await client.fetchSignal();
    expect(signal.netflows[0]?.symbol).toBe('🦄/USD');
  });

  test('drops rows with no usable netflow value, keeps the valid ones', async () => {
    const { fetchImpl } = stubFetch(
      jsonResponse([
        { symbol: 'GOOD', netflowUsd: '10' },
        { symbol: 'NO_VALUE' },
        { symbol: 'NAN', netflowUsd: 'not-a-number' },
        { symbol: 'INF', netflowUsd: 'Infinity' },
        { symbol: 'ALSO_GOOD', netflow: '20' },
      ]),
    );
    const client = createNansenClient({ apiKey: 'k', endpoint: ENDPOINT, fetchImpl });
    const signal = await client.fetchSignal();
    expect(signal.netflows.map((n) => n.symbol)).toEqual(['GOOD', 'ALSO_GOOD']);
  });

  test('caps the number of normalized rows', async () => {
    const rows = Array.from({ length: 200 }, (_, i) => ({
      symbol: `T${i}`,
      netflowUsd: String(i),
    }));
    const { fetchImpl } = stubFetch(jsonResponse(rows));
    const client = createNansenClient({ apiKey: 'k', endpoint: ENDPOINT, fetchImpl, maxRows: 5 });
    const signal = await client.fetchSignal();
    expect(signal.netflows).toHaveLength(5);
  });
});

describe('nansen client — typed failures', () => {
  test('429 → NansenRateLimitError with parsed Retry-After', async () => {
    const { fetchImpl } = stubFetch(
      new Response('{}', { status: 429, headers: { 'retry-after': '2' } }),
    );
    const client = createNansenClient({ apiKey: 'k', endpoint: ENDPOINT, fetchImpl });
    const err = await client.fetchSignal().catch((e) => e);
    expect(err).toBeInstanceOf(NansenRateLimitError);
    expect((err as NansenRateLimitError).retryAfterMs).toBe(2000);
  });

  test('5xx → NansenHttpError carrying the status', async () => {
    const { fetchImpl } = stubFetch(new Response('boom', { status: 503 }));
    const client = createNansenClient({ apiKey: 'k', endpoint: ENDPOINT, fetchImpl });
    const err = await client.fetchSignal().catch((e) => e);
    expect(err).toBeInstanceOf(NansenHttpError);
    expect((err as NansenHttpError).status).toBe(503);
  });

  test('invalid JSON → NansenParseError', async () => {
    const { fetchImpl } = stubFetch(new Response('{ not json', { status: 200 }));
    const client = createNansenClient({ apiKey: 'k', endpoint: ENDPOINT, fetchImpl });
    await expect(client.fetchSignal()).rejects.toBeInstanceOf(NansenParseError);
  });

  test('a JSON shape with no rows array → NansenParseError', async () => {
    const { fetchImpl } = stubFetch(jsonResponse({ unexpected: true }));
    const client = createNansenClient({ apiKey: 'k', endpoint: ENDPOINT, fetchImpl });
    await expect(client.fetchSignal()).rejects.toBeInstanceOf(NansenParseError);
  });

  test('an over-cap Content-Length → NansenParseError before buffering', async () => {
    const { fetchImpl } = stubFetch(
      new Response('[]', { status: 200, headers: { 'content-length': String(50 * 1024 * 1024) } }),
    );
    const client = createNansenClient({ apiKey: 'k', endpoint: ENDPOINT, fetchImpl });
    await expect(client.fetchSignal()).rejects.toBeInstanceOf(NansenParseError);
  });

  test('a generic network failure → NansenClientError (not a leaked raw error)', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('connection refused');
    }) as unknown as typeof fetch;
    const client = createNansenClient({ apiKey: 'k', endpoint: ENDPOINT, fetchImpl });
    const err = await client.fetchSignal().catch((e) => e);
    expect(err).toBeInstanceOf(NansenClientError);
  });

  test('an abort (timeout) → NansenTimeoutError', async () => {
    // A fetch that never resolves until its signal aborts, then rejects AbortError.
    const fetchImpl = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal;
        signal?.addEventListener('abort', () => {
          const e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        });
      })) as unknown as typeof fetch;
    const client = createNansenClient({ apiKey: 'k', endpoint: ENDPOINT, fetchImpl, timeoutMs: 5 });
    const err = await client.fetchSignal().catch((e) => e);
    expect(err).toBeInstanceOf(NansenTimeoutError);
    expect((err as NansenTimeoutError).timeoutMs).toBe(5);
  });
});
