import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('KBConsolidator JSON extraction', () => {
  it('extracts a bare JSON array', async () => {
    const { extractFirstJsonArray } = await import('../server/orchestrator/KBConsolidator.js');
    expect(extractFirstJsonArray('["a","b"]')).toBe('["a","b"]');
  });

  it('extracts the first array when commentary follows on later lines', async () => {
    const { extractFirstJsonArray } = await import('../server/orchestrator/KBConsolidator.js');
    const input = '[]\nNo contradictions found for [entry-123]';
    expect(extractFirstJsonArray(input)).toBe('[]');
  });

  it('ignores brackets inside JSON strings', async () => {
    const { extractFirstJsonArray } = await import('../server/orchestrator/KBConsolidator.js');
    const input = '[\"id-with-]\", \"other\"]\nAdditional note [ignored]';
    expect(extractFirstJsonArray(input)).toBe('[\"id-with-]\", \"other\"]');
  });

  it('returns null when no array is present', async () => {
    const { extractFirstJsonArray } = await import('../server/orchestrator/KBConsolidator.js');
    expect(extractFirstJsonArray('No JSON here')).toBeNull();
  });
});

describe('KBConsolidator callHaiku retry behaviour', () => {
  const okResponse = (body: unknown) => new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
  const errResponse = (status: number, headers: Record<string, string> = {}) =>
    new Response('transient', { status, headers });

  const goodBody = { content: [{ text: '["x"]' }] };
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('returns on first 200 without retrying', async () => {
    const { callHaiku } = await import('../server/orchestrator/KBConsolidator.js');
    fetchMock.mockResolvedValueOnce(okResponse(goodBody));
    const p = callHaiku('k', 'p');
    await vi.runAllTimersAsync();
    expect(await p).toBe('["x"]');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries on 529 overloaded and eventually succeeds', async () => {
    const { callHaiku } = await import('../server/orchestrator/KBConsolidator.js');
    fetchMock
      .mockResolvedValueOnce(errResponse(529))
      .mockResolvedValueOnce(errResponse(529))
      .mockResolvedValueOnce(okResponse(goodBody));
    const p = callHaiku('k', 'p');
    await vi.runAllTimersAsync();
    expect(await p).toBe('["x"]');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('retries on 500 and on TypeError fetch failed', async () => {
    const { callHaiku } = await import('../server/orchestrator/KBConsolidator.js');
    fetchMock
      .mockResolvedValueOnce(errResponse(500))
      .mockRejectedValueOnce(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }))
      .mockResolvedValueOnce(okResponse(goodBody));
    const p = callHaiku('k', 'p');
    await vi.runAllTimersAsync();
    expect(await p).toBe('["x"]');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does NOT retry on 400 bad request', async () => {
    const { callHaiku } = await import('../server/orchestrator/KBConsolidator.js');
    fetchMock.mockResolvedValueOnce(errResponse(400));
    const p = callHaiku('k', 'p');
    // Attach the rejection expectation synchronously so fake-timer-driven
    // microtask flushing doesn't surface it as an unhandled rejection.
    const assertion = expect(p).rejects.toThrow(/Anthropic API 400/);
    await vi.runAllTimersAsync();
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('gives up after MAX_RETRIES and surfaces the last error', async () => {
    const { callHaiku } = await import('../server/orchestrator/KBConsolidator.js');
    // Use an impl so each call gets a fresh Response (reading body consumes it).
    fetchMock.mockImplementation(async () => errResponse(503));
    const p = callHaiku('k', 'p');
    const assertion = expect(p).rejects.toThrow(/Anthropic API 503/);
    await vi.runAllTimersAsync();
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(4); // 1 initial + 3 retries
  });

  it('honours Retry-After on 429', async () => {
    const { callHaiku } = await import('../server/orchestrator/KBConsolidator.js');
    fetchMock
      .mockResolvedValueOnce(errResponse(429, { 'retry-after': '2' }))
      .mockResolvedValueOnce(okResponse(goodBody));
    const p = callHaiku('k', 'p');
    // Advance less than the header-requested 2s and confirm no retry yet.
    await vi.advanceTimersByTimeAsync(500);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.runAllTimersAsync();
    expect(await p).toBe('["x"]');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
