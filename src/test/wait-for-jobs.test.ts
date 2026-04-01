import { describe, expect, it } from 'vitest';

describe('wait_for_jobs backoff', () => {
  it('uses progressive polling intervals capped at 15s', async () => {
    const { nextWaitPollMs } = await import('../server/mcp/tools/waitForJobs.js');

    expect(nextWaitPollMs(0)).toBe(2000);
    expect(nextWaitPollMs(1)).toBe(3000);
    expect(nextWaitPollMs(2)).toBe(5000);
    expect(nextWaitPollMs(3)).toBe(8000);
    expect(nextWaitPollMs(4)).toBe(13000);
    expect(nextWaitPollMs(5)).toBe(15000);
    expect(nextWaitPollMs(99)).toBe(15000);
  });
});
