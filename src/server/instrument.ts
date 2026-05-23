/**
 * Sentry instrumentation — must be imported before all other modules.
 * Loaded via --import flag in the dev/start scripts so it runs before
 * Express, Socket.io, etc. are required.
 *
 * Set SENTRY_DSN in your .env to enable. When unset, Sentry is a no-op.
 */
import * as Sentry from '@sentry/node';

// Swallow EPIPE on stdout/stderr — prevents the server crashing and Sentry
// noise (HURLICANE-Q4) when the downstream log pipe is severed (terminal
// closed, parent process gone, log-collector restart). Without these
// listeners, the async 'error' event from the underlying socket becomes an
// uncaughtException that Sentry captures via captureConsoleIntegration as
// a `write EPIPE` issue originating from whatever console.log fired last.
process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code !== 'EPIPE') throw err;
});
process.stderr.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code !== 'EPIPE') throw err;
});

const dsn = process.env.SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV ?? 'development',
    tracesSampleRate: 1.0,
    // Capture 100% of errors in dev; tune down in production
    sampleRate: 1.0,
    // Attach server name so you can filter by machine in Sentry
    serverName: process.env.HOSTNAME ?? 'local',
    // Don't send PII like IP addresses
    sendDefaultPii: false,
    integrations: [
      // Capture console.warn and console.error as Sentry events
      // (so they appear as issues, not just breadcrumbs)
      Sentry.captureConsoleIntegration({ levels: ['warn', 'error'] }),
    ],
    beforeSend(event) {
      // Drop noisy operational log messages that the captureConsoleIntegration
      // would otherwise surface as issues. These are informational — they
      // indicate the system is working as designed, not that something is
      // broken. Each entry should note the Sentry issue(s) it suppresses so
      // we can re-enable if the underlying behaviour changes.
      const msg = event.message ?? event.exception?.values?.[0]?.value ?? '';

      // Hot-reload MCP session closures — expected during dev.
      if (msg.includes('[mcp] session closed')) return null;

      // Resource RSS threshold warnings — tracked separately via the
      // HealthMonitor. Suppresses HURLICANE-NH, -P8, -NY, -NS, -NM, -NG,
      // -NW, -NR, -NN, -NF, -NE, -NX, -NT, -M7, -PR, -PC, -P2, -NQ, -NJ,
      // -ND, -Q2, -PS, -P6, -P3, -P0, -NZ and similar variants. If we
      // genuinely start leaking memory we'll still see it via
      // captureWithContext from the health monitor, not console.warn.
      if (msg.includes('[resource] WARNING: orchestrator RSS')) return null;

      // Watchdog inconsistency reports — the watchdog itself recovers,
      // so the console.warn is informational. Suppresses HURLICANE-18
      // and future variants (agent/job status drift detected + cleaned).
      if (msg.includes('[watchdog] inconsistency:') && msg.includes('cleaning up')) {
        return null;
      }

      // Orphaned lock release log — the watchdog is recovering, not
      // reporting a bug. Suppresses HURLICANE-1A.
      if (msg.includes('[watchdog] releasing') && msg.includes('orphaned lock')) {
        return null;
      }

      // File-claim conflict warnings — the lock registry is doing its
      // job, the workflow will retry. Suppresses HURLICANE-9K, -GW,
      // -K7, -68, -HT and variants.
      if (msg.includes('file claim conflicts')) return null;

      // FailureClassifier debug output — when an agent fails with a
      // message the classifier doesn't recognize, it logs the tail of
      // the failure text and falls back to 'task_failure'. This fires
      // once per unique unclassified failure, and each unique message
      // creates a separate Sentry issue (~100+ historical issues
      // HURLICANE-KP..HURLICANE-GM, each with 1 event). The fallback
      // path already works correctly; the log line is purely a hint
      // for us to extend the classifier. Not a bug, not actionable
      // from Sentry.
      if (msg.includes('[FailureClassifier] Unclassified failure text')) {
        return null;
      }

      // Merge conflict pre-check warnings — when a workflow's branch
      // has conflicts with main, the pre-check logs them so we can
      // surface them in the workflow UI. This is operational
      // information, not a bug. Suppresses HURLICANE-C8, -BJ, -8P.
      if (msg.includes('merge conflict pre-check')) return null;

      // Zombie tmux session cleanup — the watchdog found a tmux
      // session without a matching agent record and killed it.
      // Recovery action, not a bug. Suppresses HURLICANE-1F.
      if (msg.includes('[watchdog] zombie tmux session')) return null;

      // MCP session auto-recovery — after a server restart, agents
      // reconnect with stale session IDs. The MCP transport
      // reestablishes automatically. Suppresses HURLICANE-1B.
      if (msg.includes('[mcp] unknown session') && msg.includes('auto-recovering')) {
        return null;
      }

      // Work-dir missing on PTY attach — when a worktree is removed
      // while a job is still queued, the PTY can't attach and the
      // job is marked failed. This is the correct behaviour (the
      // work the job would have done is gone with the worktree);
      // the warning is informational. Suppresses HURLICANE-7M.
      if (msg.includes('work_dir does not exist') && msg.includes('marking job failed')) {
        return null;
      }

      // Assess-phase missing plan/contract warnings — the workflow
      // has a 3-level repair ladder that retries automatically; the
      // log fires on each retry to help classify why `write_note`
      // wasn't called. Per-cycle repair attempts are capped, so the
      // workflow eventually blocks permanently if every repair
      // fails. The console.warn itself is purely diagnostic.
      // Suppresses HURLICANE-6Z.
      if (msg.includes('assess missing') && msg.includes('never_called')) {
        return null;
      }

      // Zero-progress watchdog warnings — the watchdog surfaces when
      // an implement agent has been active without milestone progress
      // for 15min. The workflow's zero-progress recovery path handles
      // the underlying issue (2 consecutive no-progress cycles ->
      // block). Suppresses HURLICANE-6T.
      if (msg.includes('implement agent active but 0 milestone progress')) {
        return null;
      }

      // Watchdog stuck-agent restart logs — the watchdog detected a
      // wedged agent (rate_limit / provider_overload / auth_failure /
      // launch_environment etc.) and routed the work to a fallback
      // model or provider. The restart itself is the recovery action,
      // not a bug. Suppresses HURLICANE-S3, -S4, -S8, -SA, -SB, -SC,
      // -SD, -SE and future variants. Real failures (no candidate left
      // to fall back to) escalate through other paths.
      if (msg.includes('[watchdog] agent ') && msg.includes('→ restarting')) {
        return null;
      }

      // KB consolidator transient retry logs — the Anthropic API
      // occasionally 5xxs and the consolidator retries with backoff
      // (3 attempts). The retry log fires once per attempt; only a
      // terminal failure is interesting. Suppresses HURLICANE-S9.
      if (msg.includes('[kb-consolidator]') && msg.includes('retrying in')) {
        return null;
      }

      // KB consolidation timeouts are bounded maintenance work; skipping a
      // dedup/contradiction batch is expected when the model call exceeds its
      // 30s budget, and the next run will retry from fresh data.
      if (msg.includes('[kb-consolidator]') && msg.includes('AbortError')) {
        return null;
      }

      // External provider overloads/rate limits are operational transients.
      // The orchestrator retries or routes to fallback models; raw 529 issues
      // from SDK calls just duplicate the resilience events.
      if (msg.includes('Error: 529') || msg.includes('overloaded_error')) {
        return null;
      }

      // Worktree branch auto-switch — when a worktree's HEAD has
      // drifted from the expected branch, ensureWorktreeBranch logs
      // and runs `git checkout` to recover. Same pattern fires from
      // PrCreator. The checkout failure (if any) is captured
      // separately via the workflow_blocked path. Suppresses
      // HURLICANE-S7 and pr-creator variants. Scoped to the
      // [worktree] / [pr-creator] log prefixes so generic English
      // 'X instead of Y' messages from elsewhere stay visible.
      if (
        (msg.includes('[worktree]') || msg.includes('[pr-creator]'))
        && msg.includes(' instead of ')
        && msg.includes(' — switching')
      ) {
        return null;
      }

      // Startup worktree health-check warn — the WorkflowManager
      // reconciler logs and then marks the workflow blocked. The
      // resulting WorkflowBlocked exception is captured with full
      // context via captureWithContext (HURLICANE-S5), so this
      // console.warn is redundant. Suppresses HURLICANE-S6.
      if (msg.includes('Startup worktree health check failed') && msg.includes('marking blocked')) {
        return null;
      }

      // Explicitly non-publishable repos (no usable origin) should preserve
      // worktrees and surface a blocked reason in the UI, not page Sentry.
      if (msg.includes('PR creation skipped:') && msg.includes('origin remote')) {
        return null;
      }

      return event;
    },
  });

  console.log('[sentry] Initialized');
} else {
  console.log('[sentry] SENTRY_DSN not set — Sentry disabled');
}

/**
 * Capture an exception with structured context tags (agent_id, job_id, workflow_id, component).
 * Falls back to bare captureException if Sentry is disabled — safe to call unconditionally.
 */
export function captureWithContext(
  err: unknown,
  context?: { agent_id?: string; job_id?: string; workflow_id?: string; component?: string } & Record<string, string | number | boolean | undefined>,
): void {
  Sentry.captureException(err, context ? { tags: { ...context } } : undefined);
}

export { Sentry };
