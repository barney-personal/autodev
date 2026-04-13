import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock execFileSync for tmux commands
const execFileSyncMock = vi.fn();
vi.mock('child_process', () => ({
  execFileSync: (...args: unknown[]) => execFileSyncMock(...args),
  execSync: vi.fn(() => Buffer.from('')),
}));

describe('PtyResourceManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: tmux list-sessions returns no orchestrator sessions
    execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'tmux' && args[0] === 'list-sessions') {
        return Buffer.from('');
      }
      return Buffer.from('');
    });
  });

  afterEach(async () => {
    const mod = await import('../server/orchestrator/PtyResourceManager.js');
    mod.resetBackoff();
  });

  it('returns ok when under the limit', async () => {
    const { checkResources } = await import('../server/orchestrator/PtyResourceManager.js');
    const result = checkResources(3, 2);
    expect(result.ok).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('returns not-ok when attached + spawning >= MAX', async () => {
    const { checkResources, MAX_PTY_SESSIONS } = await import('../server/orchestrator/PtyResourceManager.js');
    const result = checkResources(MAX_PTY_SESSIONS - 2, 2);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('at limit');
    expect(result.reason).toContain(String(MAX_PTY_SESSIONS));
  });

  it('returns not-ok when over the limit', async () => {
    const { checkResources, MAX_PTY_SESSIONS } = await import('../server/orchestrator/PtyResourceManager.js');
    const result = checkResources(MAX_PTY_SESSIONS, 1);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('at limit');
  });

  it('returns not-ok when tmux live session count is at limit', async () => {
    const { checkResources, MAX_PTY_SESSIONS } = await import('../server/orchestrator/PtyResourceManager.js');

    // Simulate tmux reporting MAX sessions
    const sessions = Array.from({ length: MAX_PTY_SESSIONS }, (_, i) => `orchestrator-agent-${i}`).join('\n');
    execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'tmux' && args[0] === 'list-sessions') {
        return Buffer.from(sessions + '\n');
      }
      return Buffer.from('');
    });

    // Pass 0 attached and 0 spawning (under the in-memory limit), but tmux ground-truth exceeds
    const result = checkResources(0, 0);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('tmux sessions');
    expect(result.reason).toContain('session leak');
  });

  describe('backoff escalation', () => {
    it('starts at 0', async () => {
      const { getBackoffMs } = await import('../server/orchestrator/PtyResourceManager.js');
      expect(getBackoffMs()).toBe(0);
    });

    it('escalates from 0 to 30s base', async () => {
      const { escalateBackoff, getBackoffMs } = await import('../server/orchestrator/PtyResourceManager.js');
      escalateBackoff();
      expect(getBackoffMs()).toBe(30_000);
    });

    it('doubles on each subsequent escalation', async () => {
      const { escalateBackoff, getBackoffMs } = await import('../server/orchestrator/PtyResourceManager.js');
      escalateBackoff(); // 0 -> 30s
      expect(getBackoffMs()).toBe(30_000);
      escalateBackoff(); // 30s -> 60s
      expect(getBackoffMs()).toBe(60_000);
      escalateBackoff(); // 60s -> 120s
      expect(getBackoffMs()).toBe(120_000);
      escalateBackoff(); // 120s -> 240s
      expect(getBackoffMs()).toBe(240_000);
    });

    it('caps at 300s max', async () => {
      const { escalateBackoff, getBackoffMs } = await import('../server/orchestrator/PtyResourceManager.js');
      escalateBackoff(); // 30s
      escalateBackoff(); // 60s
      escalateBackoff(); // 120s
      escalateBackoff(); // 240s
      escalateBackoff(); // would be 480s, but capped at 300s
      expect(getBackoffMs()).toBe(300_000);
      escalateBackoff(); // stays at 300s
      expect(getBackoffMs()).toBe(300_000);
    });

    it('resets backoff to 0', async () => {
      const { escalateBackoff, resetBackoff, getBackoffMs } = await import('../server/orchestrator/PtyResourceManager.js');
      escalateBackoff();
      escalateBackoff();
      expect(getBackoffMs()).toBe(60_000);
      resetBackoff();
      expect(getBackoffMs()).toBe(0);
    });
  });

  describe('backoff in checkResources', () => {
    it('returns not-ok during active backoff period', async () => {
      const { checkResources, escalateBackoff, setLastResourceErrorTime } = await import('../server/orchestrator/PtyResourceManager.js');
      escalateBackoff(); // 30s backoff
      setLastResourceErrorTime(Date.now()); // error just happened
      const result = checkResources(0, 0);
      expect(result.ok).toBe(false);
      expect(result.reason).toContain('backoff');
    });

    it('allows spawning after backoff period expires', async () => {
      const { checkResources, escalateBackoff, setLastResourceErrorTime } = await import('../server/orchestrator/PtyResourceManager.js');
      escalateBackoff(); // 30s backoff
      // Set error time far in the past (beyond backoff)
      setLastResourceErrorTime(Date.now() - 60_000);
      const result = checkResources(0, 0);
      expect(result.ok).toBe(true);
    });
  });
});
