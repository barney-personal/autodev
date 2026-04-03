import React, { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import socket from '../socket';
import { QuestionBubble } from './QuestionBubble';
import { DiffViewer } from './DiffViewer';
import type { AgentWithJob, AgentOutput, AgentOutputSegment, ClaudeStreamEvent, CodexStreamEvent, ChildAgentSummary } from '@shared/types';

// LRU cache for completed agents' rendered terminal output.
// Avoids re-fetching and re-parsing output that will never change.
const MAX_CACHE_SIZE = 50;
const renderedOutputCache = new Map<string, { text: string; truncated: boolean }>();

function cacheSet(agentId: string, entry: { text: string; truncated: boolean }) {
  if (!entry.text) return;
  // Delete-then-set keeps most-recently-used entries at the end of iteration order
  renderedOutputCache.delete(agentId);
  renderedOutputCache.set(agentId, entry);
  if (renderedOutputCache.size > MAX_CACHE_SIZE) {
    // Evict oldest (first) entry
    const oldest = renderedOutputCache.keys().next().value;
    if (oldest !== undefined) renderedOutputCache.delete(oldest);
  }
}

interface AgentTerminalProps {
  agent: AgentWithJob;
  onClose: () => void;
  onContinued?: (newAgent: AgentWithJob) => void;
  onRenameJob?: (jobId: string, newTitle: string) => void;
}

function renderEvent(event: ClaudeStreamEvent): string {
  switch (event.type) {
    case 'system': {
      const modelInfo = event.model ? ` | ${event.model}` : '';
      return `\x1b[36m[${event.subtype ?? 'system'}${modelInfo}]\x1b[0m\r\n`;
    }
    case 'assistant': {
      const content = event.message?.content ?? [];
      let out = '';
      for (const block of content) {
        if (block.type === 'text' && block.text) {
          out += `\r\n${block.text}\r\n`;
        } else if (block.type === 'tool_use' && block.name) {
          const inputStr = block.input ? JSON.stringify(block.input) : '';
          const preview = inputStr.length > 120 ? inputStr.slice(0, 120) + '…' : inputStr;
          out += `\r\n\x1b[2m⚙ ${block.name}`;
          if (preview && preview !== '{}') out += `(${preview})`;
          out += `\x1b[0m\r\n`;
        }
      }
      return out;
    }
    case 'result': {
      if (event.is_error) {
        return `\r\n\x1b[31m✗ ${event.result || 'error'}\x1b[0m\r\n`;
      }
      return `\r\n\x1b[32m✓ Done\x1b[0m\r\n`;
    }
    case 'error':
      return `\x1b[31m✗ ${event.error?.message ?? 'error'}\x1b[0m\r\n`;
    default:
      return '';
  }
}

function isCodexEvent(event: any): boolean {
  return typeof event.type === 'string' && event.type.includes('.');
}

function renderCodexEvent(event: CodexStreamEvent): string {
  switch (event.type) {
    case 'thread.started':
      return `\x1b[36m[codex thread ${event.thread_id ?? ''}]\x1b[0m\r\n`;
    case 'item.completed': {
      const item = event.item;
      if (!item) return '';
      if (item.type === 'reasoning' && item.text) {
        return `\r\n\x1b[2m\x1b[3m${item.text}\x1b[0m\r\n`;
      }
      if (item.type === 'agent_message' && item.text) {
        return `\r\n${item.text}\r\n`;
      }
      if (item.type === 'command_execution') {
        let out = `\r\n\x1b[2m⚙ ${item.command ?? 'command'}\x1b[0m\r\n`;
        if (item.aggregated_output) {
          const preview = item.aggregated_output.length > 500
            ? item.aggregated_output.slice(0, 500) + '…'
            : item.aggregated_output;
          out += `\x1b[2m${preview}\x1b[0m\r\n`;
        }
        if (item.exit_code != null && item.exit_code !== 0) {
          out += `\x1b[31m(exit ${item.exit_code})\x1b[0m\r\n`;
        }
        return out;
      }
      return '';
    }
    case 'turn.completed':
      return `\r\n\x1b[32m✓ Done\x1b[0m\r\n`;
    case 'turn.failed':
      return `\r\n\x1b[31m✗ Turn failed${event.message ? ': ' + event.message : ''}\x1b[0m\r\n`;
    case 'error':
      return `\x1b[31m✗ ${event.error?.message ?? event.message ?? 'error'}\x1b[0m\r\n`;
    default:
      return '';
  }
}

function renderAnyEvent(raw: string): string {
  try {
    const event = JSON.parse(raw);
    if (isCodexEvent(event)) {
      return renderCodexEvent(event as CodexStreamEvent);
    }
    return renderEvent(event as ClaudeStreamEvent);
  } catch {
    return raw + '\r\n';
  }
}

function RetryButton({ agentId, onRetried }: { agentId: string; onRetried: (a: AgentWithJob) => void }) {
  const [loading, setLoading] = useState(false);
  const [interactive, setInteractive] = useState(false);

  const handleRetry = async () => {
    if (loading) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/agents/${agentId}/retry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ interactive }),
      });
      if (res.ok) {
        const newAgent: AgentWithJob = await res.json();
        onRetried(newAgent);
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="continue-area">
      <div className="continue-form">
        <span className="continue-label">No session to resume.</span>
        <label className="continue-interactive-toggle" title="Open as interactive tmux session">
          <input type="checkbox" checked={interactive} onChange={e => setInteractive(e.target.checked)} />
          Interactive
        </label>
        <button className="btn btn-secondary btn-sm" onClick={handleRetry} disabled={loading}>
          {loading ? '…' : '↺ Retry'}
        </button>
      </div>
    </div>
  );
}

function CancelButton({ agentId, onCancelled }: { agentId: string; onCancelled: () => void }) {
  const [loading, setLoading] = useState(false);

  const handleCancel = async () => {
    if (loading) return;
    setLoading(true);
    try {
      await fetch(`/api/agents/${agentId}/cancel`, { method: 'POST' });
      // Always close the panel — if cancel fails (e.g. agent already stopped due to
      // a race with the watchdog), the user still wants to see the updated state.
      onCancelled();
    } finally {
      setLoading(false);
    }
  };

  return (
    <button className="btn btn-danger btn-sm" onClick={handleCancel} disabled={loading}>
      {loading ? '…' : '◻ Cancel'}
    </button>
  );
}

function ContinueInput({ agentId, onContinued }: { agentId: string; onContinued: (a: AgentWithJob) => void }) {
  const [msg, setMsg] = useState('');
  const [loading, setLoading] = useState(false);
  const [interactive, setInteractive] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!msg.trim() || loading) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/agents/${agentId}/continue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: msg.trim(), interactive }),
      });
      if (res.ok) {
        const newAgent: AgentWithJob = await res.json();
        onContinued(newAgent);
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="continue-area">
      <form onSubmit={handleSubmit} className="continue-form">
        <span className="continue-label">Continue:</span>
        <input
          type="text"
          value={msg}
          onChange={e => setMsg(e.target.value)}
          placeholder="Send a follow-up message..."
          disabled={loading}
          autoFocus
        />
        <label className="continue-interactive-toggle" title="Open as interactive tmux session">
          <input type="checkbox" checked={interactive} onChange={e => setInteractive(e.target.checked)} />
          Interactive
        </label>
        <button type="submit" className="btn btn-primary btn-sm" disabled={loading || !msg.trim()}>
          {loading ? '…' : 'Send'}
        </button>
      </form>
    </div>
  );
}

export function AgentTerminal({ agent, onClose, onContinued, onRenameJob }: AgentTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const viewStartRef = useRef<number>(Date.now());
  const [childAgents, setChildAgents] = useState<ChildAgentSummary[]>(agent.child_agents ?? []);
  const [activeTab, setActiveTab] = useState<'output' | 'changes'>('output');
  const [diff, setDiff] = useState<string | null>(agent.diff ?? null);
  const [baseSha, setBaseSha] = useState<string | null>(agent.base_sha ?? null);
  const [diffFetched, setDiffFetched] = useState(false);
  const [fullDescription, setFullDescription] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const titleInputRef = useRef<HTMLInputElement>(null);

  const startTitleEdit = () => {
    setTitleDraft(agent.job.title);
    setEditingTitle(true);
    setTimeout(() => titleInputRef.current?.select(), 0);
  };

  const commitTitleEdit = () => {
    const trimmed = titleDraft.trim();
    if (trimmed && trimmed !== agent.job.title) {
      onRenameJob?.(agent.job.id, trimmed);
    }
    setEditingTitle(false);
  };

  const handleTitleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') commitTitleEdit();
    if (e.key === 'Escape') setEditingTitle(false);
  };

  // Reset the view-start timestamp and child agents whenever we switch to a different agent
  useEffect(() => {
    viewStartRef.current = Date.now();
    setChildAgents(agent.child_agents ?? []);
    setActiveTab('output');
    setDiff(agent.diff ?? null);
    setBaseSha(agent.base_sha ?? null);
    setDiffFetched(false);
    setFullDescription(null);
    setPtySnapshotMode(false);
    ptySnapshotModeRef.current = false;
  }, [agent.id]);

  // Fetch full description if it was truncated in the snapshot
  useEffect(() => {
    if (!agent.job.description?.endsWith('…')) return;
    fetch(`/api/agents/${agent.id}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data?.job?.description) setFullDescription(data.job.description); })
      .catch(() => {});
  }, [agent.id, agent.job.description]);

  // Keep child agents up-to-date via socket events
  useEffect(() => {
    const newHandler = ({ agent: a }: { agent: AgentWithJob }) => {
      if (a.parent_agent_id === agent.id) {
        setChildAgents(prev => {
          if (prev.some(c => c.id === a.id)) return prev;
          return [...prev, { id: a.id, status: a.status, job_title: a.job.title, job_description: a.job.description }];
        });
      }
    };
    const updateHandler = ({ agent: a }: { agent: AgentWithJob }) => {
      setChildAgents(prev => prev.map(c => c.id === a.id ? { ...c, status: a.status } : c));
    };
    socket.on('agent:new', newHandler);
    socket.on('agent:update', updateHandler);
    return () => {
      socket.off('agent:new', newHandler);
      socket.off('agent:update', updateHandler);
    };
  }, [agent.id]);

  // Mark as read only once the agent has reached a terminal state AND the terminal has been
  // open for at least 2 seconds — prevents marking running continuation agents as read
  useEffect(() => {
    const TERMINAL_STATUSES = ['done', 'failed', 'cancelled'];
    if (!TERMINAL_STATUSES.includes(agent.status) || agent.output_read !== 0) return;
    const delay = Math.max(0, 2000 - (Date.now() - viewStartRef.current));
    const timer = setTimeout(() => {
      fetch(`/api/agents/${agent.id}/read`, { method: 'POST' }).catch(console.error);
    }, delay);
    return () => clearTimeout(timer);
  }, [agent.id, agent.status, agent.output_read]);

  // Fetch diff when agent completes (once per agent)
  useEffect(() => {
    const TERMINAL_STATUSES = ['done', 'failed', 'cancelled'];
    if (!TERMINAL_STATUSES.includes(agent.status)) return;
    if (diffFetched) return;
    setDiffFetched(true);
    fetch(`/api/agents/${agent.id}/diff`)
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(d => {
        setBaseSha(d.base_sha ?? null);
        setDiff(d.diff ?? null);
      })
      .catch(() => {});
  }, [agent.id, agent.status]);

  const [isTruncated, setIsTruncated] = useState(false);
  const isTruncatedRef = useRef(false);
  // loadFullHistoryRef is set inside the terminal useEffect so it closes over
  // the local `term` instance; both the button and scroll handler call it.
  const loadFullHistoryRef = useRef<() => void>(() => {});

  // Keep ref in sync with state, and reset immediately on agent switch
  useEffect(() => {
    isTruncatedRef.current = false;
    setIsTruncated(false);
  }, [agent.id]);
  useEffect(() => {
    isTruncatedRef.current = isTruncated;
  }, [isTruncated]);

  const isInteractive = !!agent.job.is_interactive;
  const [tmuxCopied, setTmuxCopied] = useState(false);
  const [ptySnapshotMode, setPtySnapshotMode] = useState(false);
  // Ref so the useEffect closure can read the latest value without re-running
  const ptySnapshotModeRef = useRef(false);
  // Exposed so the "Jump to live" button can call it
  const jumpToLiveRef = useRef<() => void>(() => {});

  const copyTmuxCommand = () => {
    const cmd = `tmux attach-session -t orchestrator-${agent.id}`;
    navigator.clipboard.writeText(cmd).then(() => {
      setTmuxCopied(true);
      setTimeout(() => setTmuxCopied(false), 2000);
    });
  };

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal({
      theme: {
        background: '#0d1117',
        foreground: '#e6edf3',
        cursor: '#58a6ff',
      },
      fontFamily: '"IBM Plex Mono", Menlo, Monaco, "Courier New", monospace',
      fontSize: 13,
      convertEol: !isInteractive,
      scrollback: 50000,
      cursorBlink: isInteractive,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);

    // Delay fit to ensure layout is ready
    requestAnimationFrame(() => {
      try { fitAddon.fit(); } catch { /* ignore */ }
    });

    termRef.current = term;

    // Shared scroll constants used by both interactive and batch modes
    const AT_BOTTOM_TOLERANCE = 5;

    if (isInteractive) {
      // Interactive mode: raw PTY data from tmux session

      // Disable input forwarding until history replay is complete — replaying raw PTY
      // history causes xterm.js to process escape sequences (e.g. DA2 queries) and
      // auto-generate terminal responses via onData, which would be forwarded to the
      // live PTY at the wrong time and appear as literal text in Claude's input field.
      let inputEnabled = false;

      // Buffer live pty:data events until history is loaded to prevent race condition
      // where new data gets written before the history, causing jumbled output.
      let historyLoaded = false;
      const pendingPtyData: string[] = [];

      const TERMINAL_STATUSES = ['done', 'failed', 'cancelled'];
      // Strip mouse reporting so scroll wheel always works in the browser viewer
      const STRIP_MOUSE_RE = /\x1b\[\?(?:1049|47|1047|1000|1002|1003|1006|1005|1004)[hl]|\x1b\[3J/g;

      fetch(`/api/agents/${agent.id}/pty-history`)
        .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
        .then((response: { mode?: string; snapshot?: string; chunks?: string[] }) => {
          if (response.mode === 'snapshot' && response.snapshot) {
            // Clean tmux snapshot: convert \n to \r\n for xterm.js
            term.write(response.snapshot.replace(/\n/g, '\r\n'));
          } else {
            // Legacy raw PTY chunk replay
            const chunks = response.chunks ?? [];
            if (chunks.length > 0) {
              const combined = chunks.map(c => c.replace(STRIP_MOUSE_RE, '')).join('');
              term.write(combined);
            }
          }
          // Flush any live data that arrived during the fetch (batched)
          if (pendingPtyData.length > 0) {
            term.write(pendingPtyData.join(''));
          }
          pendingPtyData.length = 0;
          historyLoaded = true;
          inputEnabled = true;
          // Disable mouse reporting so scrolling works in the browser
          term.write('\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1005l');
          if (TERMINAL_STATUSES.includes(agent.status)) {
            term.write('\x1b[r'); // reset scroll region to full screen
            term.scrollToTop();
            term.write('\r\n\x1b[2m[session ended]\x1b[0m\r\n');
          } else {
            // Force a resize to ensure tmux redraws at the correct client dimensions
            try { fitAddon.fit(); } catch { /* ignore */ }
            socket.emit('pty:resize', { agent_id: agent.id, cols: term.cols, rows: term.rows });
          }
          term.focus();
        })
        .catch(() => {
          // Still flush any pending data (batched)
          if (pendingPtyData.length > 0) {
            term.write(pendingPtyData.join(''));
          }
          pendingPtyData.length = 0;
          historyLoaded = true;
          inputEnabled = true;
          term.write('\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1005l');
          if (TERMINAL_STATUSES.includes(agent.status)) {
            term.write('\r\n\x1b[2m[session ended — no history available]\x1b[0m\r\n');
          } else {
            try { fitAddon.fit(); } catch { /* ignore */ }
            socket.emit('pty:resize', { agent_id: agent.id, cols: term.cols, rows: term.rows });
          }
          term.focus();
        });

      // ── Snapshot mode ────────────────────────────────────────────────────
      // Claude Code's TUI redraws the active area in-place with cursor
      // positioning. xterm.js's scrollback doesn't capture this history —
      // only tmux's scrollback does. So when the user scrolls up we switch
      // to "snapshot mode": pause live PTY writes, fetch a tmux snapshot
      // (which has the full history), render it, and let the user browse.
      // A "Jump to live" button resumes the live stream.
      let isSnapshotMode = false;
      let isRenderingSnapshot = false; // Guard against re-entrant scroll handling

      // Save scroll position as distance-from-bottom so it stays stable
      // as new content is added to the snapshot between refreshes.
      const renderSnapshot = (distFromBottom?: number) => {
        if (isRenderingSnapshot) return;
        isRenderingSnapshot = true;
        fetch(`/api/agents/${agent.id}/pty-history`)
          .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
          .then((response: { mode?: string; snapshot?: string; chunks?: string[] }) => {
            if (!isSnapshotMode) { isRenderingSnapshot = false; return; }
            term.reset();
            if (response.mode === 'snapshot' && response.snapshot) {
              term.write(response.snapshot.replace(/\n/g, '\r\n'));
            } else {
              const chunks = response.chunks ?? [];
              if (chunks.length > 0) {
                term.write(chunks.map(c => c.replace(STRIP_MOUSE_RE, '')).join(''));
              }
            }
            term.write('\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1005l');
            // Restore scroll position after write completes
            term.write('', () => {
              if (distFromBottom !== undefined) {
                const targetY = Math.max(0, term.buffer.active.length - term.rows - distFromBottom);
                term.scrollToLine(targetY);
              }
              isRenderingSnapshot = false;
            });
          })
          .catch(() => { isRenderingSnapshot = false; });
      };

      const enterSnapshotMode = () => {
        if (isSnapshotMode) return;
        isSnapshotMode = true;
        ptySnapshotModeRef.current = true;
        setPtySnapshotMode(true);
        const buf = term.buffer.active;
        const distFromBottom = buf.length - buf.viewportY;
        renderSnapshot(distFromBottom);
      };

      const exitSnapshotMode = () => {
        if (!isSnapshotMode) return;
        isSnapshotMode = false;
        ptyPaused = false;
        ptySnapshotModeRef.current = false;
        setPtySnapshotMode(false);
        isRenderingSnapshot = false;
        // Don't reset — keep the snapshot scrollback so the user can still
        // scroll up. Just scroll to bottom and resume live PTY. The pty:resize
        // forces tmux to do a full TUI redraw which updates the active area.
        term.scrollToBottom();
        try { fitAddon.fit(); } catch { /* ignore */ }
        socket.emit('pty:resize', { agent_id: agent.id, cols: term.cols, rows: term.rows });
      };

      jumpToLiveRef.current = exitSnapshotMode;

      // Detect when user scrolls up → enter snapshot mode.
      // term.onScroll only fires from write-induced auto-scroll, NOT mouse wheel.
      // Listen to the DOM scroll event on xterm's viewport element instead.
      const TERMINAL_STATUSES_SET = new Set(['done', 'failed', 'cancelled']);
      // Two-stage scroll-up handling:
      // 1. Any wheel-up event → immediately pause PTY writes
      //    (prevents auto-scroll from fighting the user's scroll)
      // 2. Sustained scroll above bottom → enter full snapshot mode (fetch tmux
      //    snapshot with complete history, show banner)
      //
      // We listen to wheel events directly instead of DOM scroll events.
      // This avoids the problem of distinguishing user scrolls from
      // programmatic auto-scrolls caused by term.write().
      let ptyPaused = false;
      let snapshotDebounceTimer: ReturnType<typeof setTimeout> | null = null;
      const SCROLL_THRESHOLD = 10;

      // Simple approach: any wheel-up event pauses PTY writes immediately.
      // We resume only when the user explicitly scrolls back to the bottom.
      // This avoids the fragile timestamp-based "is this a user scroll?" heuristic.
      const handleWheel = (e: WheelEvent) => {
        if (isRenderingSnapshot) return;
        if (TERMINAL_STATUSES_SET.has(agent.status)) return;

        // Scrolling up (deltaY < 0) → pause
        if (e.deltaY < 0) {
          ptyPaused = true;
        }

        // Scrolling down → check if we've reached the bottom
        if (e.deltaY > 0 && ptyPaused) {
          // Use a short delay to let xterm.js process the scroll first
          setTimeout(() => {
            const buf = term.buffer.active;
            const atBottom = buf.viewportY >= buf.length - term.rows - AT_BOTTOM_TOLERANCE;
            if (atBottom) {
              ptyPaused = false;
              if (snapshotDebounceTimer) {
                clearTimeout(snapshotDebounceTimer);
                snapshotDebounceTimer = null;
              }
              if (isSnapshotMode) exitSnapshotMode();
            }
          }, 50);
        }

        // Enter snapshot mode after sustained scroll-up
        if (ptyPaused && !isSnapshotMode && !snapshotDebounceTimer) {
          snapshotDebounceTimer = setTimeout(() => {
            snapshotDebounceTimer = null;
            const b = term.buffer.active;
            if (b.viewportY < b.length - term.rows - SCROLL_THRESHOLD) {
              enterSnapshotMode();
            }
          }, 300);
        }
      };
      containerRef.current?.addEventListener('wheel', handleWheel as EventListener, { passive: true, capture: true });

      const ptyDataHandler = ({ agent_id, data }: { agent_id: string; data: string }) => {
        if (agent_id !== agent.id) return;
        if (!historyLoaded) {
          pendingPtyData.push(data);
          return;
        }
        if (ptyPaused || isSnapshotMode || isRenderingSnapshot) return; // Discard while scrolled up
        term.write(data.replace(STRIP_MOUSE_RE, ''));
      };
      const ptyClosedHandler = ({ agent_id }: { agent_id: string }) => {
        if (agent_id !== agent.id) return;
        if (isSnapshotMode) exitSnapshotMode();
        term.write('\r\n\x1b[2m[session ended]\x1b[0m\r\n');
      };
      socket.on('pty:data', ptyDataHandler);
      socket.on('pty:closed', ptyClosedHandler);

      // Forward keyboard input — skip while history is replaying, and filter out
      // DA1/DA2 device-attribute responses that xterm.js generates automatically
      // (ESC[>params c / ESC[?params c); these must not reach Claude's input field.
      const inputDispose = term.onData((data) => {
        if (!inputEnabled) return;
        if (/^\x1b\[[\?>][0-9;]*c$/.test(data)) return;
        socket.emit('pty:input', { agent_id: agent.id, data });
      });

      // Handle resize (debounced to prevent rapid-fire resize events that
      // cause many tmux redraws and can overwhelm xterm.js rendering)
      let resizeTimer: ReturnType<typeof setTimeout> | null = null;
      const resizeObserver = new ResizeObserver(() => {
        if (resizeTimer) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
          try {
            fitAddon.fit();
            socket.emit('pty:resize', { agent_id: agent.id, cols: term.cols, rows: term.rows });
          } catch { /* ignore */ }
        }, 100);
      });
      if (containerRef.current) resizeObserver.observe(containerRef.current);

      return () => {
        socket.off('pty:data', ptyDataHandler);
        socket.off('pty:closed', ptyClosedHandler);
        containerRef.current?.removeEventListener('wheel', handleWheel as EventListener, { capture: true });
        if (snapshotDebounceTimer) clearTimeout(snapshotDebounceTimer);
        inputDispose.dispose();
        if (resizeTimer) clearTimeout(resizeTimer);
        resizeObserver.disconnect();
        term.dispose();
        termRef.current = null;
      };
    } else {
      // Batch mode: try rendered stream-json output first (clean, parsed).
      // Fall back to PTY snapshot for sub-agents spawned via create_job that
      // have no agent_output rows but do have tmux PTY data.
      const TAIL = 5000;
      const TERMINAL_STATUSES = ['done', 'failed', 'cancelled'];

      // Disposables we need to clean up — populated by whichever path succeeds
      const disposables: Array<() => void> = [];

      const isCompleted = TERMINAL_STATUSES.includes(agent.status);
      const cached = isCompleted ? renderedOutputCache.get(agent.id) : undefined;

      // Helper: write rendered output to the terminal (used by both cache hit and fetch paths)
      const applyRenderedOutput = (result: { text: string; truncated: boolean }) => {
        term.reset(); // reset() clears the entire buffer including scrollback; clear() only pushes to scrollback
        if (result.truncated) {
          term.write(`\x1b[2m[showing last ${TAIL} lines — scroll to top to load more]\x1b[0m\r\n`);
        }
        term.write(result.text);
        setIsTruncated(result.truncated);
      };

      if (cached) {
        // Cache hit — skip network fetch entirely
        applyRenderedOutput(cached);
      } else {
        term.write('\x1b[2mLoading output…\x1b[0m');
      }

      // For cache misses (or running agents), fetch from server
      const fetchPromise = cached
        ? Promise.resolve()  // skip fetch — already applied
        : fetch(`/api/agents/${agent.id}/rendered-output?tail=${TAIL}`)
          .then(r => r.json())
          .then((result: { text: string; truncated: boolean }) => {
            // If rendered output is trivially small (e.g. just a "Done" result line),
            // the real output is likely in the PTY log — fall through to PTY path.
            if (!result.text || result.text.length < 100) throw new Error('no rendered output');

            applyRenderedOutput(result);
            term.focus();

            // Cache for completed agents
            if (isCompleted) cacheSet(agent.id, result);

            // Stream live stream-json output (only for running agents)
            if (!isCompleted) {
              // Buffer output while the user is scrolled up instead of writing
              // and trying to restore scroll position (which races with xterm.js
              // auto-scroll and causes the viewport to snap back to bottom).
              let batchScrolledUp = false;
              let bufferedOutput = '';

              const batchViewportEl = containerRef.current?.querySelector('.xterm-viewport');
              let batchLastWheelTime = 0;
              const batchHandleWheel = () => { batchLastWheelTime = Date.now(); };
              containerRef.current?.addEventListener('wheel', batchHandleWheel, { passive: true, capture: true });

              const batchHandleScroll = () => {
                const wheelTimeout = batchScrolledUp ? 1500 : 300;
                const isUser = Date.now() - batchLastWheelTime < wheelTimeout;
                if (!isUser) return;
                const buf = term.buffer.active;
                const atBottom = buf.viewportY >= buf.length - term.rows - AT_BOTTOM_TOLERANCE;
                if (!atBottom) {
                  batchScrolledUp = true;
                } else if (batchScrolledUp) {
                  // User scrolled back to bottom — flush buffered output
                  batchScrolledUp = false;
                  if (bufferedOutput) {
                    const toWrite = bufferedOutput;
                    bufferedOutput = '';
                    term.write(toWrite);
                  }
                }
              };
              batchViewportEl?.addEventListener('scroll', batchHandleScroll);

              let pendingOutput = '';
              let rafId: number | null = null;
              const flushPending = () => {
                rafId = null;
                if (!pendingOutput) return;
                const toWrite = pendingOutput;
                pendingOutput = '';
                if (batchScrolledUp) {
                  bufferedOutput += toWrite;
                } else {
                  term.write(toWrite);
                }
              };
              const outputHandler = ({ agent_id, line }: { agent_id: string; line: AgentOutput }) => {
                if (agent_id !== agent.id) return;
                const rendered = renderAnyEvent(line.content);
                if (!rendered) return;
                pendingOutput += rendered;
                if (rafId === null) rafId = requestAnimationFrame(flushPending);
              };
              socket.on('agent:output', outputHandler);
              disposables.push(() => {
                socket.off('agent:output', outputHandler);
                if (rafId !== null) cancelAnimationFrame(rafId);
                batchViewportEl?.removeEventListener('scroll', batchHandleScroll);
                containerRef.current?.removeEventListener('wheel', batchHandleWheel, { capture: true } as EventListenerOptions);
              });
            }
          })
        .catch(() => {
          // No stream-json output — fall back to PTY snapshot (sub-agents)
          term.reset();
          // Strip mouse reporting and alternate screen sequences so scroll always works
          const STRIP_MOUSE_RE = /\x1b\[\?(?:1049|47|1047|1000|1002|1003|1006|1005|1004)[hl]|\x1b\[3J/g;

          fetch(`/api/agents/${agent.id}/pty-history`)
            .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
            .then((response: { mode?: string; snapshot?: string; chunks?: string[] }) => {
              const hasData = (response.mode === 'snapshot' && response.snapshot) ||
                              (response.chunks && response.chunks.length > 0);
              if (!hasData) { term.write('\x1b[2mNo output available.\x1b[0m\r\n'); return; }

              term.options.convertEol = false;
              if (response.mode === 'snapshot' && response.snapshot) {
                term.write(response.snapshot.replace(/\n/g, '\r\n'));
              } else {
                const chunks = response.chunks ?? [];
                const combined = chunks.map(c => c.replace(STRIP_MOUSE_RE, '')).join('');
                term.write(combined);
              }

              // Disable mouse reporting so scrolling works in view-only mode
              term.write('\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1005l');

              // Send resize to match viewer dimensions, then request a clean snapshot
              socket.emit('pty:resize', { agent_id: agent.id, cols: term.cols, rows: term.rows });
              if (agent.status === 'running') {
                // Request a fresh snapshot after resize for a clean view
                socket.emit('pty:resize-and-snapshot', { agent_id: agent.id, cols: term.cols, rows: term.rows });
              }

              if (TERMINAL_STATUSES.includes(agent.status)) {
                term.write('\x1b[r');
                term.scrollToTop();
                term.write('\r\n\x1b[2m[session ended]\x1b[0m\r\n');
              }

              term.focus();

              // Stream live PTY data (strip mouse reporting so scroll keeps working)
              const ptyDataHandler = ({ agent_id, data }: { agent_id: string; data: string }) => {
                if (agent_id !== agent.id) return;
                term.write(data.replace(STRIP_MOUSE_RE, ''));
              };
              const ptyClosedHandler = ({ agent_id }: { agent_id: string }) => {
                if (agent_id !== agent.id) return;
                term.write('\r\n\x1b[2m[session ended]\x1b[0m\r\n');
              };
              socket.on('pty:data', ptyDataHandler);
              socket.on('pty:closed', ptyClosedHandler);
              disposables.push(() => {
                socket.off('pty:data', ptyDataHandler);
                socket.off('pty:closed', ptyClosedHandler);
              });

              // Listen for snapshot refresh after resize
              const onSnapshotRefresh = ({ agent_id, snapshot }: { agent_id: string; snapshot: string }) => {
                if (agent_id === agent.id && snapshot) {
                  term.reset();
                  term.write(snapshot.replace(/\n/g, '\r\n'));
                  // Re-disable mouse reporting after snapshot refresh
                  term.write('\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1005l');
                  term.focus();
                }
              };
              socket.on('pty:snapshot-refresh', onSnapshotRefresh);
              disposables.push(() => {
                socket.off('pty:snapshot-refresh', onSnapshotRefresh);
              });
            })
            .catch(() => {
              term.write('\x1b[2mNo output available.\x1b[0m\r\n');
            });
        });

      // Wire up load-full-history
      loadFullHistoryRef.current = () => {
        if (!isTruncatedRef.current) return;
        isTruncatedRef.current = false;
        setIsTruncated(false);
        term.reset();
        term.write('\x1b[2mLoading full history…\x1b[0m');
        fetch(`/api/agents/${agent.id}/rendered-output`)
          .then(r => r.json())
          .then((result: { text: string; truncated: boolean }) => {
            term.reset();
            if (result.text) term.write(result.text);
            term.scrollToTop();
          })
          .catch(console.error);
      };

      const scrollDispose = term.onScroll((position) => {
        if (position < 50) loadFullHistoryRef.current();
      });

      // Handle resize (debounced)
      let resizeTimer: ReturnType<typeof setTimeout> | null = null;
      const resizeObserver = new ResizeObserver(() => {
        if (resizeTimer) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
          try {
            fitAddon.fit();
            // Also resize the tmux session to match
            socket.emit('pty:resize', { agent_id: agent.id, cols: term.cols, rows: term.rows });
          } catch { /* ignore */ }
        }, 150);
      });
      if (containerRef.current) resizeObserver.observe(containerRef.current);

      return () => {
        for (const d of disposables) d();
        scrollDispose.dispose();
        if (resizeTimer) clearTimeout(resizeTimer);
        resizeObserver.disconnect();
        term.dispose();
        termRef.current = null;
      };
    }
  }, [agent.id]);

  const contextEntries: [string, string][] = (() => {
    try {
      const parsed = agent.job.context ? JSON.parse(agent.job.context) : null;
      return parsed && typeof parsed === 'object' ? Object.entries(parsed) : [];
    } catch { return []; }
  })();

  return (
    <div className="terminal-panel">
      <div className="terminal-header">
        <div className="terminal-header-info">
          <span className="terminal-agent-id">Agent {agent.id.slice(0, 6)}</span>
          {editingTitle ? (
            <input
              ref={titleInputRef}
              className="terminal-job-title-input"
              value={titleDraft}
              onChange={e => setTitleDraft(e.target.value)}
              onBlur={commitTitleEdit}
              onKeyDown={handleTitleKeyDown}
            />
          ) : (
            <span className="terminal-job-title">
              {agent.job.title}
              <button
                className="btn-icon rename-title-btn"
                title="Rename job"
                onClick={startTitleEdit}
              >
                ✎
              </button>
            </span>
          )}
        </div>
        <div className="terminal-header-actions">
          <button
            className="btn btn-sm"
            onClick={copyTmuxCommand}
            title={`tmux attach-session -t orchestrator-${agent.id}`}
          >
            {tmuxCopied ? 'Copied!' : 'Copy tmux'}
          </button>
          {isInteractive && (agent.status === 'running' || agent.status === 'starting') && (
            <button
              className="btn btn-danger btn-sm"
              onClick={() => fetch(`/api/agents/${agent.id}/disconnect`, { method: 'DELETE' })}
            >
              Disconnect
            </button>
          )}
          {isInteractive && agent.status === 'failed' && (
            <button
              className="btn btn-sm"
              onClick={() => fetch(`/api/agents/${agent.id}/reconnect`, { method: 'POST' })}
              title="Re-attach to the tmux session if it is still alive"
            >
              Reconnect
            </button>
          )}
          {!isInteractive && ['starting', 'running', 'waiting_user'].includes(agent.status) && (
            <CancelButton agentId={agent.id} onCancelled={onClose} />
          )}
          <button
            className={`flag-btn${agent.job.flagged ? ' flag-btn-active' : ''}`}
            onClick={() => fetch(`/api/jobs/${agent.job.id}/flag`, { method: 'POST' })}
            title={agent.job.flagged ? 'Remove flag' : 'Flag for review'}
            aria-label={agent.job.flagged ? 'Remove flag' : 'Flag for review'}
            aria-pressed={!!agent.job.flagged}
            style={{ fontSize: '16px' }}
          >
            ⚑
          </button>
          <button className="btn-icon" onClick={onClose} aria-label="Close terminal panel">✕</button>
        </div>
      </div>

      <div className="job-request-section">
        <div className="job-request-header">
          <div className="job-request-label">Request</div>
          {agent.job.model && (
            <span className="agent-stat agent-stat-model" title={agent.job.model}>
              {agent.job.model.replace('claude-', '')}
            </span>
          )}
        </div>
        <div className="job-request-description">{fullDescription ?? agent.job.description}</div>
        {(agent.cost_usd != null || agent.duration_ms != null || agent.num_turns != null) && (
          <div className="agent-run-stats">
            {agent.cost_usd != null && (
              <span className="agent-stat" title="Total cost">
                💰 ${agent.cost_usd.toFixed(4)}
              </span>
            )}
            {agent.duration_ms != null && (
              <span className="agent-stat" title="Runtime">
                ⏱ {agent.duration_ms >= 60000
                  ? `${Math.floor(agent.duration_ms / 60000)}m ${Math.round((agent.duration_ms % 60000) / 1000)}s`
                  : `${(agent.duration_ms / 1000).toFixed(1)}s`}
              </span>
            )}
            {agent.num_turns != null && (
              <span className="agent-stat" title="Number of turns">
                ↩ {agent.num_turns} turns
              </span>
            )}
          </div>
        )}
        {contextEntries.length > 0 && (
          <div className="job-request-context">
            {contextEntries.map(([k, v]) => (
              <div key={k} className="job-context-row">
                <span className="job-context-key">{k}:</span>
                <span className="job-context-value">{v}</span>
              </div>
            ))}
          </div>
        )}
        {childAgents.length > 0 && (
          <div className="job-followups">
            <div className="job-followups-label">Follow-ups</div>
            {childAgents.map(child => (
              <button
                key={child.id}
                className="followup-link"
                onClick={async () => {
                  try {
                    const res = await fetch(`/api/agents/${child.id}`);
                    if (res.ok && onContinued) onContinued(await res.json());
                  } catch (err) {
                    console.error('Failed to load child agent:', err);
                  }
                }}
              >
                <span className={`followup-status-dot followup-status-${child.status}`} />
                <span className="followup-description">{child.job_description}</span>
                <span className="followup-id">{child.id.slice(0, 6)}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {agent.pending_question && agent.status === 'waiting_user' && (
        <QuestionBubble question={agent.pending_question} />
      )}

      <div className="terminal-tabs">
        <button
          className={`terminal-tab${activeTab === 'output' ? ' terminal-tab-active' : ''}`}
          onClick={() => setActiveTab('output')}
        >
          Output
        </button>
        {(['done', 'failed', 'cancelled'].includes(agent.status)) && (
          <button
            className={`terminal-tab${activeTab === 'changes' ? ' terminal-tab-active' : ''}`}
            onClick={() => setActiveTab('changes')}
          >
            Changes{diff ? ` (${diff.split('\n').filter(l => l.startsWith('+')).length - diff.split('\n').filter(l => l.startsWith('--- ')).length}+)` : ''}
          </button>
        )}
      </div>

      {isTruncated && activeTab === 'output' && (
        <div className="output-truncated-bar">
          <span>Showing last 5000 lines.</span>
          <button className="btn btn-sm" onClick={() => loadFullHistoryRef.current()}>Load full history</button>
        </div>
      )}
      {ptySnapshotMode && activeTab === 'output' && (
        <div className="output-truncated-bar">
          <span>Viewing history snapshot — scroll to bottom to resume live</span>
          <button className="btn btn-sm btn-primary" onClick={() => jumpToLiveRef.current()}>Jump to live</button>
        </div>
      )}
      <div ref={containerRef} className={`xterm-container${activeTab !== 'output' ? ' xterm-hidden' : ''}`} />

      {activeTab === 'changes' && (
        <div className="diff-panel">
          {diff
            ? <DiffViewer diff={diff} />
            : baseSha
              ? <div className="diff-empty">No file changes detected.</div>
              : <div className="diff-empty">No changes captured — the working directory is not a git repository.<br />Initialize git in the work directory to enable diff tracking.</div>
          }
        </div>
      )}

      {agent.status === 'failed' && agent.error_message && (
        <div className="agent-error-banner">
          <div className="agent-error-label">Error output</div>
          <pre className="agent-error-text">{agent.error_message}</pre>
        </div>
      )}

      {agent.status === 'failed' && !agent.session_id && onContinued && (
        <RetryButton agentId={agent.id} onRetried={onContinued} />
      )}

      {(agent.status === 'done' || (agent.status === 'failed' && agent.session_id)) && onContinued && (
        <ContinueInput agentId={agent.id} onContinued={onContinued} />
      )}
    </div>
  );
}
