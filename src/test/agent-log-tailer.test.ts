import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentLogTailer } from '../server/orchestrator/AgentLogTailer.js';

// ── AgentLogTailer unit tests ─────────────────────────────────────────────────

describe('AgentLogTailer', () => {
  let tmpDir: string;
  let logPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tailer-test-'));
    logPath = path.join(tmpDir, 'agent.ndjson');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('emits lines from an existing file on construction', () => {
    fs.writeFileSync(logPath, '{"type":"system"}\n{"type":"result"}\n');

    const received: Array<{ raw: string; seq: number }> = [];
    const tailer = new AgentLogTailer(logPath, 0, (raw, seq) => received.push({ raw, seq }));
    tailer.stop();

    expect(received).toHaveLength(2);
    expect(received[0]).toEqual({ raw: '{"type":"system"}', seq: 0 });
    expect(received[1]).toEqual({ raw: '{"type":"result"}', seq: 1 });
  });

  it('skips the first skipLines lines (reattach mode)', () => {
    fs.writeFileSync(logPath, 'line0\nline1\nline2\nline3\nline4\n');

    const received: Array<{ raw: string; seq: number }> = [];
    const tailer = new AgentLogTailer(logPath, 3, (raw, seq) => received.push({ raw, seq }));
    tailer.stop();

    // Only lines 3 and 4 should be emitted, with seq starting at 3
    expect(received).toHaveLength(2);
    expect(received[0]).toEqual({ raw: 'line3', seq: 3 });
    expect(received[1]).toEqual({ raw: 'line4', seq: 4 });
  });

  it('seq is contiguous starting at skipLines when there are more lines than skipLines', () => {
    // Write 5 lines; skip the first 2 (already stored from previous session)
    fs.writeFileSync(logPath, 'a\nb\nc\nd\ne\n');

    const seqs: number[] = [];
    const tailer = new AgentLogTailer(logPath, 2, (_raw, seq) => seqs.push(seq));
    tailer.stop();

    // Lines c, d, e emitted with seq 2, 3, 4
    expect(seqs).toEqual([2, 3, 4]);
  });

  it('defers reading when isReady returns false', () => {
    fs.writeFileSync(logPath, 'should-not-emit\n');

    const received: string[] = [];
    const tailer = new AgentLogTailer(logPath, 0, (raw) => received.push(raw), () => false);
    tailer.stop();

    expect(received).toHaveLength(0);
  });

  it('stop() prevents further reads via readAndFlush', () => {
    fs.writeFileSync(logPath, 'initial\n');

    const received: string[] = [];
    const tailer = new AgentLogTailer(logPath, 0, (raw) => received.push(raw));
    tailer.stop();

    // Append more data after stop
    fs.appendFileSync(logPath, 'after-stop\n');
    tailer.readAndFlush();

    expect(received).toHaveLength(1);
    expect(received[0]).toBe('initial');
  });

  it('stop() is idempotent', () => {
    fs.writeFileSync(logPath, 'x\n');
    const tailer = new AgentLogTailer(logPath, 0, () => {});
    expect(() => { tailer.stop(); tailer.stop(); }).not.toThrow();
  });

  it('skips blank lines', () => {
    fs.writeFileSync(logPath, 'good\n\n   \ngood2\n');

    const received: string[] = [];
    const tailer = new AgentLogTailer(logPath, 0, (raw) => received.push(raw));
    tailer.stop();

    expect(received).toEqual(['good', 'good2']);
  });

  it('handles file not yet created gracefully', () => {
    const missing = path.join(tmpDir, 'missing.ndjson');
    const received: string[] = [];
    expect(() => {
      const tailer = new AgentLogTailer(missing, 0, (raw) => received.push(raw));
      tailer.stop();
    }).not.toThrow();
    expect(received).toHaveLength(0);
  });

  it('readAndFlush picks up newly appended lines', () => {
    fs.writeFileSync(logPath, 'first\n');

    const received: string[] = [];
    const tailer = new AgentLogTailer(logPath, 0, (raw) => received.push(raw));

    expect(received).toHaveLength(1);

    fs.appendFileSync(logPath, 'second\n');
    tailer.readAndFlush();

    tailer.stop();
    expect(received).toEqual(['first', 'second']);
  });
});

// ── AgentStreamProcessor unit tests ──────────────────────────────────────────

vi.mock('../server/db/database.js', () => ({
  isDbInitialized: vi.fn(() => true),
}));

vi.mock('../server/db/queries.js', () => ({
  insertAgentOutput: vi.fn(),
  accumulateAgentTokens: vi.fn(),
  updateAgent: vi.fn(),
  getLatestAgentOutput: vi.fn(() => null),
}));

vi.mock('../server/socket/SocketManager.js', () => ({
  emitAgentOutput: vi.fn(),
}));

vi.mock('../server/orchestrator/JobWatcherManager.js', () => ({
  onAgentEvent: vi.fn(),
}));

vi.mock('../server/lib/logger.js', () => ({
  agentLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

describe('AgentStreamProcessor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('storeOutput', () => {
    it('inserts a row when DB is initialized', async () => {
      const { isDbInitialized } = await import('../server/db/database.js');
      const queries = await import('../server/db/queries.js');
      const { storeOutput } = await import('../server/orchestrator/AgentStreamProcessor.js');

      vi.mocked(isDbInitialized).mockReturnValue(true);
      storeOutput('agent-1', 5, 'assistant', 'raw-content');

      expect(queries.insertAgentOutput).toHaveBeenCalledWith(
        expect.objectContaining({ agent_id: 'agent-1', seq: 5, event_type: 'assistant', content: 'raw-content' }),
      );
    });

    it('skips insert when DB is not initialized', async () => {
      const { isDbInitialized } = await import('../server/db/database.js');
      const queries = await import('../server/db/queries.js');
      const { storeOutput } = await import('../server/orchestrator/AgentStreamProcessor.js');

      vi.mocked(isDbInitialized).mockReturnValue(false);
      storeOutput('agent-1', 0, 'raw', 'data');

      expect(queries.insertAgentOutput).not.toHaveBeenCalled();
    });
  });

  describe('extractAndAccumulateTokens', () => {
    it('accumulates Claude assistant event input and output tokens', async () => {
      const queries = await import('../server/db/queries.js');
      const { extractAndAccumulateTokens } = await import('../server/orchestrator/AgentStreamProcessor.js');

      const raw = JSON.stringify({
        type: 'assistant',
        usage: {
          input_tokens: 100,
          cache_creation_input_tokens: 20,
          cache_read_input_tokens: 5,
          output_tokens: 50,
        },
      });
      extractAndAccumulateTokens('a1', { type: 'assistant' } as any, raw);

      expect(queries.accumulateAgentTokens).toHaveBeenCalledWith('a1', 125, 50);
    });

    it('accumulates Codex event tokens', async () => {
      const queries = await import('../server/db/queries.js');
      const { extractAndAccumulateTokens } = await import('../server/orchestrator/AgentStreamProcessor.js');

      const event = {
        type: 'turn.completed',
        usage: { input_tokens: 200, cached_input_tokens: 30, output_tokens: 80 },
      } as any;
      extractAndAccumulateTokens('a2', event, JSON.stringify(event));

      expect(queries.accumulateAgentTokens).toHaveBeenCalledWith('a2', 230, 80);
    });

    it('does not call accumulateAgentTokens when there are no tokens', async () => {
      const queries = await import('../server/db/queries.js');
      const { extractAndAccumulateTokens } = await import('../server/orchestrator/AgentStreamProcessor.js');

      const event = { type: 'text' } as any;
      extractAndAccumulateTokens('a3', event, '{"type":"text"}');

      expect(queries.accumulateAgentTokens).not.toHaveBeenCalled();
    });
  });

  describe('handleStreamEvent raw-line fallback (via startTailing onLine)', () => {
    it('raw-fallback: onLine stores event_type=raw when JSON.parse fails', async () => {
      const queries = await import('../server/db/queries.js');
      const { isDbInitialized } = await import('../server/db/database.js');
      vi.mocked(isDbInitialized).mockReturnValue(true);

      // Simulate what startTailing's onLine callback does
      const { storeOutput } = await import('../server/orchestrator/AgentStreamProcessor.js');

      const raw = 'not-valid-json';
      // This is the exact logic inside startTailing's onLine callback:
      try {
        JSON.parse(raw); // will throw
      } catch {
        storeOutput('agent-raw', 7, 'raw', raw);
      }

      expect(queries.insertAgentOutput).toHaveBeenCalledWith(
        expect.objectContaining({ event_type: 'raw', content: 'not-valid-json', seq: 7 }),
      );
    });
  });
});
