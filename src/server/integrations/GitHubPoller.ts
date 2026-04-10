import { execFileSync } from 'child_process';
import * as queries from '../db/queries.js';
import { getEyeTargets } from '../orchestrator/EyeConfig.js';
import { wakeEye } from '../api/eye.js';
import { Sentry } from '../instrument.js';

const DEFAULT_POLL_INTERVAL_MS = 300_000; // 5 minutes
const GH_AUTHOR_FILTER = 'kphurley7'; // Don't wake Eye for the user's own PRs

interface PrInfo {
  number: number;
  title: string;
  author: { login: string };
  createdAt: string;
  updatedAt: string;
  isDraft: boolean;
  url: string;
}

interface StoredPrState {
  [prNumber: number]: {
    updatedAt: string;
    commentCount: number;
    title: string;
    isDraft: boolean;
  };
}

interface PollerStatus {
  running: boolean;
  lastPollAt: number | null;
  repos: string[];
  lastEvents: string[];
  errors: string[];
}

let pollTimer: ReturnType<typeof setInterval> | null = null;
let pollerStatus: PollerStatus = {
  running: false,
  lastPollAt: null,
  repos: [],
  lastEvents: [],
  errors: [],
};

function getRepoSlug(repoDir: string): string | null {
  try {
    const result = execFileSync('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], {
      encoding: 'utf-8',
      timeout: 15_000,
      cwd: repoDir,
    }).trim();
    return result || null;
  } catch {
    return null;
  }
}

function isGitRepo(dir: string): boolean {
  try {
    execFileSync('git', ['rev-parse', '--git-dir'], {
      encoding: 'utf-8',
      timeout: 5_000,
      cwd: dir,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
}

function fetchPrList(repoDir: string): PrInfo[] {
  try {
    const result = execFileSync(
      'gh',
      ['pr', 'list', '--json', 'number,title,author,createdAt,updatedAt,isDraft,url', '--limit', '20'],
      { encoding: 'utf-8', timeout: 30_000, cwd: repoDir },
    );
    return JSON.parse(result);
  } catch {
    return [];
  }
}

function fetchPrCommentCount(repoDir: string, prNumber: number): number {
  try {
    const result = execFileSync(
      'gh',
      ['pr', 'view', String(prNumber), '--json', 'comments', '-q', '.comments | length'],
      { encoding: 'utf-8', timeout: 15_000, cwd: repoDir },
    );
    return parseInt(result.trim(), 10) || 0;
  } catch {
    return -1; // signal failure — don't false-positive on comment changes
  }
}

function getNoteKey(repoSlug: string): string {
  return `github/prs/${repoSlug}`;
}

function getStoredState(repoSlug: string): StoredPrState {
  const note = queries.getNote(getNoteKey(repoSlug));
  if (!note?.value) return {};
  try {
    return JSON.parse(note.value);
  } catch {
    return {};
  }
}

function saveState(repoSlug: string, state: StoredPrState): void {
  queries.upsertNote(getNoteKey(repoSlug), JSON.stringify(state), null);
}

function pollRepo(repoDir: string): string[] {
  const events: string[] = [];

  const repoSlug = getRepoSlug(repoDir);
  if (!repoSlug) {
    pollerStatus.errors.push(`Could not determine repo slug for ${repoDir}`);
    return events;
  }

  const prs = fetchPrList(repoDir);
  if (prs.length === 0) return events;

  const oldState = getStoredState(repoSlug);
  const newState: StoredPrState = {};

  for (const pr of prs) {
    // Skip PRs authored by the user
    if (pr.author?.login === GH_AUTHOR_FILTER) {
      // Still track state to avoid false positives if filter changes
      newState[pr.number] = {
        updatedAt: pr.updatedAt,
        commentCount: oldState[pr.number]?.commentCount ?? 0,
        title: pr.title,
        isDraft: pr.isDraft,
      };
      continue;
    }

    const old = oldState[pr.number];

    if (!old) {
      // New PR
      const event = `new PR #${pr.number}: "${pr.title}" by ${pr.author?.login}`;
      events.push(event);
      wakeEye(event);

      newState[pr.number] = {
        updatedAt: pr.updatedAt,
        commentCount: fetchPrCommentCount(repoDir, pr.number),
        title: pr.title,
        isDraft: pr.isDraft,
      };
      continue;
    }

    // PR existed before — check for changes
    let changed = false;

    if (pr.updatedAt !== old.updatedAt) {
      // Check for new comments on recently updated PRs
      const commentCount = fetchPrCommentCount(repoDir, pr.number);
      if (commentCount > 0 && commentCount > old.commentCount) {
        const event = `PR #${pr.number} has ${commentCount - old.commentCount} new comment(s): "${pr.title}"`;
        events.push(event);
        wakeEye(event);
        changed = true;
      }

      // Check draft status change
      if (pr.isDraft !== old.isDraft) {
        const event = pr.isDraft
          ? `PR #${pr.number} converted to draft: "${pr.title}"`
          : `PR #${pr.number} marked ready for review: "${pr.title}"`;
        events.push(event);
        wakeEye(event);
        changed = true;
      }

      // Generic update if nothing specific detected
      if (!changed && pr.updatedAt !== old.updatedAt) {
        const event = `PR #${pr.number} updated: "${pr.title}"`;
        events.push(event);
        wakeEye(event);
      }

      newState[pr.number] = {
        updatedAt: pr.updatedAt,
        commentCount: commentCount >= 0 ? commentCount : old.commentCount,
        title: pr.title,
        isDraft: pr.isDraft,
      };
    } else {
      // No change
      newState[pr.number] = old;
    }
  }

  saveState(repoSlug, newState);

  if (!pollerStatus.repos.includes(repoSlug)) {
    pollerStatus.repos.push(repoSlug);
  }

  return events;
}

function runPoll(): void {
  const targets = getEyeTargets();
  const allEvents: string[] = [];
  pollerStatus.errors = [];

  for (const target of targets) {
    if (!isGitRepo(target.path)) continue;

    try {
      const events = pollRepo(target.path);
      allEvents.push(...events);
    } catch (err: any) {
      const msg = `Error polling ${target.path}: ${err?.message ?? err}`;
      console.error(`[github-poller] ${msg}`);
      Sentry.captureException(err);
      pollerStatus.errors.push(msg);
    }
  }

  pollerStatus.lastPollAt = Date.now();
  // Keep last 20 events
  pollerStatus.lastEvents = [...allEvents, ...pollerStatus.lastEvents].slice(0, 20);

  if (allEvents.length > 0) {
    console.log(`[github-poller] ${allEvents.length} event(s) detected`);
  }
}

function getPollIntervalMs(): number {
  const val = queries.getNote('setting:eye:githubPollIntervalMs')?.value;
  const parsed = val ? parseInt(val, 10) : NaN;
  return isNaN(parsed) || parsed < 30_000 ? DEFAULT_POLL_INTERVAL_MS : parsed;
}

export function startGitHubPoller(): void {
  if (pollTimer) return;

  const targets = getEyeTargets();
  if (targets.length === 0) {
    console.log('[github-poller] No Eye targets configured — skipping start');
    return;
  }

  // Check if gh CLI is available
  try {
    execFileSync('gh', ['--version'], { encoding: 'utf-8', timeout: 5_000, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch {
    console.log('[github-poller] gh CLI not available — skipping start');
    return;
  }

  const intervalMs = getPollIntervalMs();
  pollerStatus.running = true;
  pollerStatus.repos = [];

  console.log(`[github-poller] Starting with ${intervalMs / 1000}s interval for ${targets.length} target(s)`);

  // Run first poll after a short delay (don't block server startup)
  setTimeout(() => {
    runPoll();
    // Set up recurring poll
    pollTimer = setInterval(runPoll, intervalMs);
  }, 5_000);
}

export function stopGitHubPoller(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  pollerStatus.running = false;
  console.log('[github-poller] Stopped');
}

export function getGitHubPollerStatus(): PollerStatus {
  return { ...pollerStatus };
}
