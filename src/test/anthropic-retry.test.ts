/**
 * Unit tests for the shared Anthropic retry/classification helper.
 *
 * Sentry 7478227754 (5xx), 7498967456 (529 overloaded) and 7507566417
 * (EHOSTUNREACH → ETIMEDOUT after the host lost its network) were all one
 * root cause: a bare `messages.create` in a session tick with no retry and no
 * transient classification. The resolver had the status half of this logic;
 * this module is that logic shared, plus transport-failure classification.
 */
import { describe, it, expect, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import {
  isRetryableApiError,
  getAnthropicErrorStatus,
  createAnthropicMessage,
  MAX_ANTHROPIC_API_RETRIES,
} from '../server/orchestrator/anthropicRetry.js';

function clientReturning(create: (...args: unknown[]) => unknown): () => Anthropic {
  return () => ({ messages: { create } }) as unknown as Anthropic;
}

const noopLog = { warn: () => { /* noop */ } };

describe('isRetryableApiError — provider statuses', () => {
  it('treats the transient status set as retryable', () => {
    for (const status of [408, 429, 500, 502, 503, 504, 529]) {
      expect(isRetryableApiError(Object.assign(new Error('boom'), { status }))).toBe(true);
      // …and when the status only shows up in the message, as it does for
      // the SDK's `529 {"type":"overloaded_error"}` formatting.
      expect(isRetryableApiError(new Error(`${status} something went wrong`))).toBe(true);
    }
  });

  it('treats client-side statuses as permanent', () => {
    for (const status of [400, 401, 403, 404, 422]) {
      expect(isRetryableApiError(Object.assign(new Error('nope'), { status }))).toBe(false);
    }
  });

  it('lets a hard status win over connection-ish wording in the body', () => {
    // A 400 whose body happens to mention a connection must not be retried
    // forever — the status is authoritative.
    const err = Object.assign(new Error('400 invalid_request_error: Connection error.'), { status: 400 });
    expect(isRetryableApiError(err)).toBe(false);
  });

  it('reads the status from status, statusCode, or the message', () => {
    expect(getAnthropicErrorStatus(Object.assign(new Error('x'), { status: 503 }))).toBe(503);
    expect(getAnthropicErrorStatus(Object.assign(new Error('x'), { statusCode: 429 }))).toBe(429);
    expect(getAnthropicErrorStatus(new Error('500 Internal Server Error'))).toBe(500);
    expect(getAnthropicErrorStatus(new Error('Connection error.'))).toBeNull();
  });
});

describe('isRetryableApiError — transport failures', () => {
  it('recognises the SDK APIConnectionError shape without instanceof', () => {
    // Several suites replace '@anthropic-ai/sdk' with a stub module that has
    // no error classes, so classification must not rely on instanceof.
    class APIConnectionError extends Error {}
    expect(isRetryableApiError(new APIConnectionError('Connection error.'))).toBe(true);
    class APIConnectionTimeoutError extends Error {}
    expect(isRetryableApiError(new APIConnectionTimeoutError('Request timed out.'))).toBe(true);
  });

  it('recognises errno codes on the cause chain', () => {
    // What actually reached Sentry as 7507566417: the SDK's generic
    // "Connection error." wrapping undici's fetch failure, wrapping the
    // real EHOSTUNREACH / ETIMEDOUT syscall error.
    const syscall = Object.assign(new Error('connect EHOSTUNREACH 2607:6bc0::/64:443'), { code: 'EHOSTUNREACH' });
    const undici = Object.assign(new Error('fetch failed'), { cause: syscall });
    const sdk = Object.assign(new Error('Connection error.'), { cause: undici });
    expect(isRetryableApiError(sdk)).toBe(true);
    expect(isRetryableApiError(undici)).toBe(true);
    expect(isRetryableApiError(syscall)).toBe(true);
    expect(isRetryableApiError(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }))).toBe(true);
    expect(isRetryableApiError(Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' }))).toBe(true);
  });

  it('does not treat ordinary application errors as transient', () => {
    expect(isRetryableApiError(new Error('Cannot read properties of undefined'))).toBe(false);
    expect(isRetryableApiError(new Error('Database not initialized. Call initDb() first.'))).toBe(false);
    expect(isRetryableApiError(new TypeError('x is not a function'))).toBe(false);
    expect(isRetryableApiError(undefined)).toBe(false);
  });
});

describe('createAnthropicMessage', () => {
  it('retries a transient failure and returns the eventual success', async () => {
    const create = vi.fn()
      .mockRejectedValueOnce(new Error('529 overloaded_error'))
      .mockRejectedValueOnce(Object.assign(new Error('Connection error.'), { cause: new Error('fetch failed') }))
      .mockResolvedValue({ id: 'msg_ok' });
    const log = { warn: vi.fn() };

    const resp = await createAnthropicMessage(clientReturning(create), {} as never, log);

    expect(resp).toEqual({ id: 'msg_ok' });
    expect(create).toHaveBeenCalledTimes(3);
    expect(log.warn).toHaveBeenCalledTimes(2);
  });

  it('rethrows a non-retryable error without a second attempt', async () => {
    const create = vi.fn().mockRejectedValue(Object.assign(new Error('400 invalid tool schema'), { status: 400 }));

    await expect(createAnthropicMessage(clientReturning(create), {} as never, noopLog))
      .rejects.toThrow('400 invalid tool schema');
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('gives up and rethrows once the retry budget is spent — failures stay loud', async () => {
    const create = vi.fn().mockRejectedValue(new Error('500 Internal Server Error'));

    await expect(createAnthropicMessage(clientReturning(create), {} as never, noopLog))
      .rejects.toThrow('500 Internal Server Error');
    expect(create).toHaveBeenCalledTimes(MAX_ANTHROPIC_API_RETRIES + 1);
  });

  it('honours a caller-supplied retry budget', async () => {
    const create = vi.fn().mockRejectedValue(new Error('503 Service Unavailable'));

    await expect(createAnthropicMessage(clientReturning(create), {} as never, noopLog, { maxRetries: 1 }))
      .rejects.toThrow('503');
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('re-reads the client factory on every attempt', async () => {
    // The callers keep a module-level singleton that tests swap out; the
    // helper must not capture it once.
    const create = vi.fn()
      .mockRejectedValueOnce(new Error('502 Bad Gateway'))
      .mockResolvedValue({ id: 'msg_ok' });
    const getClient = vi.fn(clientReturning(create));

    await createAnthropicMessage(getClient, {} as never, noopLog);

    expect(getClient).toHaveBeenCalledTimes(2);
  });
});
