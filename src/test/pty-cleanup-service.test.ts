import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const cleanupStaleTmuxSessionsMock = vi.fn(() => ({
  scanned: 0,
  killed: 0,
  skipped: 0,
  errors: 0,
}));

vi.mock('../server/orchestrator/PtyManager.js', () => ({
  cleanupStaleTmuxSessions: cleanupStaleTmuxSessionsMock,
}));

vi.mock('../server/instrument.js', () => ({
  captureWithContext: vi.fn(),
}));

describe('PtyCleanupService', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    const { _resetPtyCleanupServiceForTest } = await import('../server/orchestrator/PtyCleanupService.js');
    _resetPtyCleanupServiceForTest();
  });

  afterEach(async () => {
    const { _resetPtyCleanupServiceForTest } = await import('../server/orchestrator/PtyCleanupService.js');
    _resetPtyCleanupServiceForTest();
    vi.useRealTimers();
  });

  it('runs cleanup immediately and on the configured interval', async () => {
    const { startPtyCleanupService, stopPtyCleanupService } = await import('../server/orchestrator/PtyCleanupService.js');

    startPtyCleanupService(1000);
    expect(cleanupStaleTmuxSessionsMock).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1000);
    expect(cleanupStaleTmuxSessionsMock).toHaveBeenCalledTimes(2);

    stopPtyCleanupService();
    vi.advanceTimersByTime(1000);
    expect(cleanupStaleTmuxSessionsMock).toHaveBeenCalledTimes(2);
  });

  it('is idempotent when started twice', async () => {
    const { startPtyCleanupService } = await import('../server/orchestrator/PtyCleanupService.js');

    startPtyCleanupService(1000);
    startPtyCleanupService(1000);
    expect(cleanupStaleTmuxSessionsMock).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1000);
    expect(cleanupStaleTmuxSessionsMock).toHaveBeenCalledTimes(2);
  });
});
