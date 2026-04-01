// Sentry must be imported first to instrument all subsequent modules
import { Sentry } from './instrument.js';
import { createServer } from 'http';
import express from 'express';
import compression from 'compression';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { initDb, closeDb } from './db/database.js';
import { initSocketManager } from './socket/SocketManager.js';
import apiRouter from './api/router.js';
import { createMcpApp, closeAllMcpSessions } from './mcp/McpServer.js';
import { startWorkQueue, stopWorkQueue, setMaxConcurrent } from './orchestrator/WorkQueueManager.js';
import { startWatchdog, stopWatchdog } from './orchestrator/StuckJobWatchdog.js';
import { startHealthMonitor, stopHealthMonitor } from './orchestrator/HealthMonitor.js';
import { startWorktreeCleanup, stopWorktreeCleanup } from './orchestrator/WorktreeCleanup.js';
import { startKBConsolidator, stopKBConsolidator } from './orchestrator/KBConsolidator.js';
import { startGitHubPoller, stopGitHubPoller } from './integrations/GitHubPoller.js';
import { runRecovery, startWorkflowGapDetector, stopWorkflowGapDetector } from './orchestrator/recovery.js';
import { startResourceMonitor, stopResourceMonitor, setQueueControls } from './orchestrator/ResourceMonitor.js';
import { startDbBackup, stopDbBackup, runBackupNow } from './orchestrator/DbBackup.js';
import { writeInput, resizePty, resizeAndSnapshot, saveSnapshot, isTmuxSessionAlive } from './orchestrator/PtyManager.js';
import * as queries from './db/queries.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT ?? 3456);
const MCP_PORT = Number(process.env.MCP_PORT ?? 3947);
const DB_PATH = process.env.DB_PATH ?? path.join(process.cwd(), 'data', 'orchestrator.db');

// ── Global error handlers ────────────────────────────────────────────────────
// Log uncaught errors but EXIT for fatal ones (e.g. EADDRINUSE from a duplicate
// server process). Without exit, a zombie process keeps running WorkQueue and
// dispatching agents whose socket events go nowhere.
process.on('uncaughtException', (err: NodeJS.ErrnoException) => {
  console.error('[server] Uncaught exception:', err);
  Sentry.captureException(err);
  if (err.code === 'EADDRINUSE' || err.code === 'EACCES') {
    console.error('[server] Fatal: port already in use — exiting to avoid zombie process');
    process.exit(1);
  }
});
process.on('unhandledRejection', (reason) => {
  console.error('[server] Unhandled rejection:', reason);
  Sentry.captureException(reason);
});

async function main() {
  // 1. Init database
  initDb(DB_PATH);
  console.log(`[server] DB initialized at ${DB_PATH}`);

  // Populate FTS index for any existing output rows not yet indexed
  queries.rebuildFts();

  // 2. Recovery — mark stale agents as failed, requeue their jobs
  runRecovery();

  // 3. Main Express app
  const app = express();
  app.use(cors());
  app.use(compression());
  app.use(express.json());

  // REST API
  app.use('/api', apiRouter);

  // Sentry request handler — adds request context to all events
  Sentry.setupExpressErrorHandler(app);

  // Serve built client in production
  const clientDist = path.join(__dirname, '../../dist/client');
  app.use(express.static(clientDist));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'));
  });

  // 4. HTTP server + Socket.io
  const httpServer = createServer(app);
  const io = initSocketManager(httpServer);

  // Send snapshot on connect; also respond to explicit re-requests (e.g. after StrictMode remount or HMR)
  // Short-TTL cache so multiple rapid connections (HMR, tabs) don't each run the full query set.
  let snapshotCache: { data: any; expires: number } | null = null;
  const SNAPSHOT_CACHE_TTL = 1500; // 1.5s

  const buildSnapshot = () => {
    const now = Date.now();
    if (snapshotCache && now < snapshotCache.expires) return snapshotCache.data;
    const data = {
      jobs: queries.listJobsSlim(),
      agents: queries.getAgentsWithJobForSnapshot(),
      locks: queries.getAllActiveLocks(),
      templates: queries.listTemplates(),
      projects: queries.listProjects(),
      batchTemplates: queries.listBatchTemplates(),
      debates: queries.listDebates(),
      workflows: queries.listWorkflows(),
      discussions: queries.listDiscussions(),
      proposals: queries.listProposals(),
    };
    snapshotCache = { data, expires: now + SNAPSHOT_CACHE_TTL };
    return data;
  };

  io.on('connection', (socket) => {
    try { socket.emit('queue:snapshot', buildSnapshot()); } catch (err) { console.error('[socket] snapshot error:', err); }

    socket.on('request:snapshot', () => {
      try { socket.emit('queue:snapshot', buildSnapshot()); } catch (err) { console.error('[socket] snapshot error:', err); }
    });

    socket.on('pty:input', ({ agent_id, data }) => { try { writeInput(agent_id, data); } catch (err) { console.error('[socket] pty:input error:', err); } });
    socket.on('pty:resize', ({ agent_id, cols, rows }) => { try { resizePty(agent_id, cols, rows); } catch (err) { console.error('[socket] pty:resize error:', err); } });
    socket.on('pty:resize-and-snapshot', async ({ agent_id, cols, rows }) => {
      try {
        const snapshot = await resizeAndSnapshot(agent_id, cols, rows);
        if (snapshot) {
          socket.emit('pty:snapshot-refresh', { agent_id, snapshot });
        }
      } catch (err) {
        console.error('[socket] pty:resize-and-snapshot error:', err);
      }
    });
  });

  // 5. MCP server on separate port
  const mcpApp = createMcpApp();
  const mcpServer = mcpApp.listen(MCP_PORT, () => {
    console.log(`[server] MCP server listening on :${MCP_PORT}`);
  });
  // Disable idle timeouts on the MCP server. Node.js defaults (keepAliveTimeout=5s,
  // headersTimeout=60s, requestTimeout=300s) close HTTP connections mid-flight on
  // long-running tools like wait_for_jobs, leaving agents hung.
  mcpServer.keepAliveTimeout = 0;
  mcpServer.headersTimeout = 0;
  mcpServer.requestTimeout = 0;
  // Enable TCP keepalive probes so the OS doesn't silently drop idle connections
  // during long wait_for_jobs polls (no bytes flow while the server-side loop runs).
  mcpServer.on('connection', (socket) => {
    socket.setKeepAlive(true, 30_000);
  });

  // 6. Start work queue + stuck-job watchdog
  startWorkQueue();
  startWatchdog();
  startHealthMonitor();
  startWorktreeCleanup();
  startWorkflowGapDetector();
  startKBConsolidator();
  startGitHubPoller();
  startResourceMonitor();
  startDbBackup(DB_PATH);
  setQueueControls(stopWorkQueue, startWorkQueue);

  // Restore persisted settings
  const savedMax = queries.getNote('setting:maxConcurrentAgents');
  if (savedMax) setMaxConcurrent(Number(savedMax.value));

  // 7. Start main server
  httpServer.listen(PORT, () => {
    console.log(`[server] Orchestrator listening on :${PORT}`);
  });

  // 8. Graceful shutdown with connection draining
  let shuttingDown = false;

  /** Exposed for health checks — true once shutdown begins */
  function isShuttingDown(): boolean { return shuttingDown; }

  async function shutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[server] ${signal} received — shutting down gracefully`);

    // Hard-exit watchdog: if shutdown takes >30s, force it
    // (increased from 10s to allow running agents time to reach a checkpoint)
    const watchdog = setTimeout(() => {
      console.error('[server] Shutdown timed out — forcing exit');
      process.exit(1);
    }, 30_000);
    watchdog.unref(); // don't let this alone keep the process alive

    // Phase 1: Stop dispatching new jobs but keep monitors running briefly
    // so in-flight agents can still report status and release locks.
    stopWorkQueue();
    console.log('[server] stopped work queue — no new jobs will be dispatched');

    // Phase 2: Notify all running agents to finish gracefully.
    // Send SIGTERM to give them a chance to commit work-in-progress.
    try {
      const runningAgents = queries.listAllRunningAgents();
      if (runningAgents.length > 0) {
        console.log(`[server] sending SIGTERM to ${runningAgents.length} running agent(s)`);
        for (const agent of runningAgents) {
          if (agent.pid != null) {
            try { process.kill(agent.pid, 'SIGTERM'); } catch { /* already gone */ }
          }
        }
        // Give agents a brief window to wrap up (e.g. finish current tool call)
        const DRAIN_TIMEOUT_MS = 5_000;
        await new Promise(resolve => setTimeout(resolve, DRAIN_TIMEOUT_MS));
      }
    } catch (err) {
      console.error('[server] error during agent drain:', err);
    }

    // Phase 3: Stop all periodic monitors
    stopWatchdog();
    stopHealthMonitor();
    stopWorktreeCleanup();
    stopWorkflowGapDetector();
    stopKBConsolidator();
    stopGitHubPoller();
    stopResourceMonitor();
    stopDbBackup();

    // Run a final backup before closing the database
    runBackupNow();

    // Phase 4: Save tmux snapshots for all running agents so recovery on restart
    // has the latest terminal state.
    try {
      const runningAgents = queries.listAllRunningAgents();
      let snapshotCount = 0;
      for (const agent of runningAgents) {
        if (isTmuxSessionAlive(agent.id)) {
          saveSnapshot(agent.id);
          snapshotCount++;
        }
      }
      if (snapshotCount > 0) {
        console.log(`[server] saved ${snapshotCount} agent snapshot(s) before shutdown`);
      }
    } catch (err) {
      console.error('[server] error saving agent snapshots:', err);
    }

    // Phase 5: Stop accepting new HTTP connections; wait for in-flight requests to drain
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));

    // Close all active MCP sessions so clients get a clean disconnect
    await closeAllMcpSessions();

    // Close the MCP server
    await new Promise<void>((resolve) => mcpServer.close(() => resolve()));

    // Disconnect all Socket.io clients
    io.close();

    // Close the database
    closeDb();

    // Flush Sentry events before exit
    await Sentry.flush(2000).catch(() => {});

    clearTimeout(watchdog);
    console.log('[server] Shutdown complete');
    process.exit(0);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM').catch(err => { console.error('[server] Shutdown error:', err); process.exit(1); }));
  process.on('SIGINT',  () => shutdown('SIGINT').catch(err => { console.error('[server] Shutdown error:', err); process.exit(1); }));
}

main().catch((err) => {
  console.error('[server] Fatal error:', err);
  process.exit(1);
});
