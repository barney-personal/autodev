import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import socket from '../socket';
import { renderAnyEvent, cacheGet, cacheSet } from '../components/terminal-renderers';
import type { AgentOutput } from '@shared/types';

const TERMINAL_STATUSES = ['done', 'failed', 'cancelled'];
const TERMINAL_STATUSES_SET = new Set(TERMINAL_STATUSES);
const AT_BOTTOM_TOLERANCE = 5;
const STRIP_MOUSE_RE = /\x1b\[\?(?:1049|47|1047|1000|1002|1003|1006|1005|1004)[hl]|\x1b\[3J/g;
const TAIL = 5000;

export interface UseTerminalReturn {
  containerRef: React.RefObject<HTMLDivElement>;
  isTruncated: boolean;
  ptySnapshotMode: boolean;
  loadFullHistory: () => void;
  jumpToLive: () => void;
}

/**
 * Manages the xterm.js terminal lifecycle: creates/destroys the Terminal
 * instance, handles interactive PTY or batch rendered-output modes,
 * snapshot scrollback, live streaming, and resize observation.
 */
export function useTerminal(
  agentId: string,
  agentStatus: string,
  isInteractive: boolean,
): UseTerminalReturn {
  const containerRef = useRef<HTMLDivElement>(null);

  const [isTruncated, setIsTruncated] = useState(false);
  const isTruncatedRef = useRef(false);
  const loadFullHistoryRef = useRef<() => void>(() => {});

  const [ptySnapshotMode, setPtySnapshotMode] = useState(false);
  const ptySnapshotModeRef = useRef(false);
  const jumpToLiveRef = useRef<() => void>(() => {});

  // Reset on agent switch
  useEffect(() => {
    isTruncatedRef.current = false;
    setIsTruncated(false);
    setPtySnapshotMode(false);
    ptySnapshotModeRef.current = false;
  }, [agentId]);

  useEffect(() => {
    isTruncatedRef.current = isTruncated;
  }, [isTruncated]);

  // ── Main terminal lifecycle ───────────────────────────────────────────────
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
    requestAnimationFrame(() => {
      try { fitAddon.fit(); } catch { /* ignore */ }
    });

    if (isInteractive) {
      return setupInteractiveTerminal(
        term, fitAddon, agentId, agentStatus, containerRef,
        setPtySnapshotMode, ptySnapshotModeRef, jumpToLiveRef,
      );
    } else {
      return setupBatchTerminal(
        term, fitAddon, agentId, agentStatus, containerRef,
        setIsTruncated, isTruncatedRef, loadFullHistoryRef,
      );
    }
  }, [agentId]);

  return {
    containerRef,
    isTruncated,
    ptySnapshotMode,
    loadFullHistory: () => loadFullHistoryRef.current(),
    jumpToLive: () => jumpToLiveRef.current(),
  };
}

// ── Interactive terminal setup ──────────────────────────────────────────────
function setupInteractiveTerminal(
  term: Terminal,
  fitAddon: FitAddon,
  agentId: string,
  agentStatus: string,
  containerRef: React.RefObject<HTMLDivElement>,
  setPtySnapshotMode: (v: boolean) => void,
  ptySnapshotModeRef: React.MutableRefObject<boolean>,
  jumpToLiveRef: React.MutableRefObject<() => void>,
): () => void {
  let inputEnabled = false;
  let historyLoaded = false;
  const pendingPtyData: string[] = [];

  fetch(`/api/agents/${agentId}/pty-history`)
    .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
    .then((response: { mode?: string; snapshot?: string; chunks?: string[] }) => {
      if (response.mode === 'snapshot' && response.snapshot) {
        term.write(response.snapshot.replace(/\n/g, '\r\n'));
      } else {
        const chunks = response.chunks ?? [];
        if (chunks.length > 0) {
          const combined = chunks.map(c => c.replace(STRIP_MOUSE_RE, '')).join('');
          term.write(combined);
        }
      }
      if (pendingPtyData.length > 0) term.write(pendingPtyData.join(''));
      pendingPtyData.length = 0;
      historyLoaded = true;
      inputEnabled = true;
      term.write('\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1005l');
      if (TERMINAL_STATUSES.includes(agentStatus)) {
        term.write('\x1b[r');
        term.scrollToTop();
        term.write('\r\n\x1b[2m[session ended]\x1b[0m\r\n');
      } else {
        try { fitAddon.fit(); } catch { /* ignore */ }
        socket.emit('pty:resize', { agent_id: agentId, cols: term.cols, rows: term.rows });
      }
      term.focus();
    })
    .catch(() => {
      if (pendingPtyData.length > 0) term.write(pendingPtyData.join(''));
      pendingPtyData.length = 0;
      historyLoaded = true;
      inputEnabled = true;
      term.write('\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1005l');
      if (TERMINAL_STATUSES.includes(agentStatus)) {
        term.write('\r\n\x1b[2m[session ended \u2014 no history available]\x1b[0m\r\n');
      } else {
        try { fitAddon.fit(); } catch { /* ignore */ }
        socket.emit('pty:resize', { agent_id: agentId, cols: term.cols, rows: term.rows });
      }
      term.focus();
    });

  // ── Snapshot mode ───────────────────────────────────────────────────────
  let isSnapshotMode = false;
  let isRenderingSnapshot = false;

  const renderSnapshot = (distFromBottom?: number) => {
    if (isRenderingSnapshot) return;
    isRenderingSnapshot = true;
    fetch(`/api/agents/${agentId}/pty-history`)
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
    term.scrollToBottom();
    try { fitAddon.fit(); } catch { /* ignore */ }
    socket.emit('pty:resize', { agent_id: agentId, cols: term.cols, rows: term.rows });
  };

  jumpToLiveRef.current = exitSnapshotMode;

  // ── Scroll handling ─────────────────────────────────────────────────────
  let ptyPaused = false;
  let snapshotDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  const SCROLL_THRESHOLD = 10;

  const handleWheel = (e: WheelEvent) => {
    if (isRenderingSnapshot) return;
    if (TERMINAL_STATUSES_SET.has(agentStatus)) return;

    if (e.deltaY < 0) ptyPaused = true;

    if (e.deltaY > 0 && ptyPaused) {
      setTimeout(() => {
        const buf = term.buffer.active;
        const atBottom = buf.viewportY >= buf.length - term.rows - AT_BOTTOM_TOLERANCE;
        if (atBottom) {
          ptyPaused = false;
          if (snapshotDebounceTimer) { clearTimeout(snapshotDebounceTimer); snapshotDebounceTimer = null; }
          if (isSnapshotMode) exitSnapshotMode();
        }
      }, 50);
    }

    if (ptyPaused && !isSnapshotMode && !snapshotDebounceTimer) {
      snapshotDebounceTimer = setTimeout(() => {
        snapshotDebounceTimer = null;
        const b = term.buffer.active;
        if (b.viewportY < b.length - term.rows - SCROLL_THRESHOLD) enterSnapshotMode();
      }, 300);
    }
  };
  containerRef.current?.addEventListener('wheel', handleWheel as EventListener, { passive: true, capture: true });

  // ── PTY data streaming ──────────────────────────────────────────────────
  const ptyDataHandler = ({ agent_id, data }: { agent_id: string; data: string }) => {
    if (agent_id !== agentId) return;
    if (!historyLoaded) { pendingPtyData.push(data); return; }
    if (ptyPaused || isSnapshotMode || isRenderingSnapshot) return;
    term.write(data.replace(STRIP_MOUSE_RE, ''));
  };
  const ptyClosedHandler = ({ agent_id }: { agent_id: string }) => {
    if (agent_id !== agentId) return;
    if (isSnapshotMode) exitSnapshotMode();
    term.write('\r\n\x1b[2m[session ended]\x1b[0m\r\n');
  };
  socket.on('pty:data', ptyDataHandler);
  socket.on('pty:closed', ptyClosedHandler);

  const inputDispose = term.onData((data) => {
    if (!inputEnabled) return;
    if (/^\x1b\[[\?>][0-9;]*c$/.test(data)) return;
    socket.emit('pty:input', { agent_id: agentId, data });
  });

  let resizeTimer: ReturnType<typeof setTimeout> | null = null;
  const resizeObserver = new ResizeObserver(() => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      try {
        fitAddon.fit();
        socket.emit('pty:resize', { agent_id: agentId, cols: term.cols, rows: term.rows });
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
  };
}

// ── Batch terminal setup ────────────────────────────────────────────────────
function setupBatchTerminal(
  term: Terminal,
  fitAddon: FitAddon,
  agentId: string,
  agentStatus: string,
  containerRef: React.RefObject<HTMLDivElement>,
  setIsTruncated: (v: boolean) => void,
  isTruncatedRef: React.MutableRefObject<boolean>,
  loadFullHistoryRef: React.MutableRefObject<() => void>,
): () => void {
  const disposables: Array<() => void> = [];
  const isCompleted = TERMINAL_STATUSES.includes(agentStatus);
  const cached = isCompleted ? cacheGet(agentId) : undefined;

  const applyRenderedOutput = (result: { text: string; truncated: boolean }) => {
    term.reset();
    if (result.truncated) {
      term.write(`\x1b[2m[showing last ${TAIL} lines \u2014 scroll to top to load more]\x1b[0m\r\n`);
    }
    term.write(result.text);
    setIsTruncated(result.truncated);
  };

  if (cached) {
    applyRenderedOutput(cached);
  } else {
    term.write('\x1b[2mLoading output\u2026\x1b[0m');
  }

  void (cached
    ? Promise.resolve()
    : fetch(`/api/agents/${agentId}/rendered-output?tail=${TAIL}`)
        .then(r => r.json())
        .then((result: { text: string; truncated: boolean }) => {
          if (!result.text || result.text.length < 100) throw new Error('no rendered output');

          applyRenderedOutput(result);
          term.focus();
          if (isCompleted) cacheSet(agentId, result);

          if (!isCompleted) {
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
              if (agent_id !== agentId) return;
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
        term.reset();
        fetch(`/api/agents/${agentId}/pty-history`)
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

            term.write('\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1005l');
            socket.emit('pty:resize', { agent_id: agentId, cols: term.cols, rows: term.rows });
            if (agentStatus === 'running') {
              socket.emit('pty:resize-and-snapshot', { agent_id: agentId, cols: term.cols, rows: term.rows });
            }

            if (TERMINAL_STATUSES.includes(agentStatus)) {
              term.write('\x1b[r');
              term.scrollToTop();
              term.write('\r\n\x1b[2m[session ended]\x1b[0m\r\n');
            }
            term.focus();

            const ptyDataHandler = ({ agent_id, data }: { agent_id: string; data: string }) => {
              if (agent_id !== agentId) return;
              term.write(data.replace(STRIP_MOUSE_RE, ''));
            };
            const ptyClosedHandler = ({ agent_id }: { agent_id: string }) => {
              if (agent_id !== agentId) return;
              term.write('\r\n\x1b[2m[session ended]\x1b[0m\r\n');
            };
            socket.on('pty:data', ptyDataHandler);
            socket.on('pty:closed', ptyClosedHandler);
            disposables.push(() => {
              socket.off('pty:data', ptyDataHandler);
              socket.off('pty:closed', ptyClosedHandler);
            });

            const onSnapshotRefresh = ({ agent_id, snapshot }: { agent_id: string; snapshot: string }) => {
              if (agent_id === agentId && snapshot) {
                term.reset();
                term.write(snapshot.replace(/\n/g, '\r\n'));
                term.write('\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1005l');
                term.focus();
              }
            };
            socket.on('pty:snapshot-refresh', onSnapshotRefresh);
            disposables.push(() => { socket.off('pty:snapshot-refresh', onSnapshotRefresh); });
          })
          .catch(() => { term.write('\x1b[2mNo output available.\x1b[0m\r\n'); });
      }));

  loadFullHistoryRef.current = () => {
    if (!isTruncatedRef.current) return;
    isTruncatedRef.current = false;
    setIsTruncated(false);
    term.reset();
    term.write('\x1b[2mLoading full history\u2026\x1b[0m');
    fetch(`/api/agents/${agentId}/rendered-output`)
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

  let resizeTimer: ReturnType<typeof setTimeout> | null = null;
  const resizeObserver = new ResizeObserver(() => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      try {
        fitAddon.fit();
        socket.emit('pty:resize', { agent_id: agentId, cols: term.cols, rows: term.rows });
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
  };
}
