import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';
import { setupTestDb, cleanupTestDb, createSocketMock, insertTestWorkflow, insertTestJob } from './helpers.js';

vi.mock('../server/socket/SocketManager.js', () => createSocketMock());

import * as queries from '../server/db/queries.js';
import {
  dispatchResolverTool,
  _internal,
} from '../server/orchestrator/ResolverTools.js';

const { resolveWorktreeRelativePath, resolveNoteKey, capUntrustedText, ALLOWED_GIT_VERBS } = _internal;

describe('ResolverTools — path safety', () => {
  beforeEach(() => setupTestDb());
  afterEach(() => cleanupTestDb());

  it('rejects absolute paths', async () => {
    const wf = await insertTestWorkflow({ work_dir: '/tmp/wf-test' });
    const r = resolveWorktreeRelativePath(wf, '/etc/passwd');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/absolute/i);
  });

  it('rejects parent traversal', async () => {
    const wf = await insertTestWorkflow({ work_dir: '/tmp/wf-test' });
    const r = resolveWorktreeRelativePath(wf, '../../etc/passwd');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/traversal/i);
  });

  it('rejects edits under .git', async () => {
    const wf = await insertTestWorkflow({ work_dir: '/tmp/wf-test' });
    const r = resolveWorktreeRelativePath(wf, '.git/config');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/\.git/);
  });

  it('rejects edits under node_modules', async () => {
    const wf = await insertTestWorkflow({ work_dir: '/tmp/wf-test' });
    const r = resolveWorktreeRelativePath(wf, 'node_modules/foo/index.js');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/node_modules/);
  });

  it('accepts a normal relative file path', async () => {
    const wf = await insertTestWorkflow({ work_dir: '/tmp/wf-test' });
    const r = resolveWorktreeRelativePath(wf, 'src/foo.ts');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.relative).toBe('src/foo.ts');
      expect(r.absolute).toBe('/tmp/wf-test/src/foo.ts');
    }
  });

  it('rejects sneaky traversal via normalized segments', async () => {
    const wf = await insertTestWorkflow({ work_dir: '/tmp/wf-test' });
    const r = resolveWorktreeRelativePath(wf, 'src/../../etc/passwd');
    expect(r.ok).toBe(false);
  });
});

describe('ResolverTools — read_agent_log path safety', () => {
  beforeEach(() => setupTestDb());
  afterEach(() => cleanupTestDb());

  it('rejects path-traversal agent_ids', async () => {
    const wf = await insertTestWorkflow();
    const run = queries.insertResolverRun({
      id: 'run-path-1', workflow_id: wf.id, trigger_reason: 'test', reason_fingerprint: 'fp',
      attempt: 1, model: 'claude-opus-4-7',
    });
    const result = dispatchResolverTool(run, {
      type: 'tool_use', id: 'u1', name: 'read_agent_log',
      input: { agent_id: '../../etc/passwd', kind: 'ndjson' },
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/UUID/i);
  });

  it('rejects non-UUID agent_ids even if they look harmless', async () => {
    const wf = await insertTestWorkflow();
    const run = queries.insertResolverRun({
      id: 'run-path-2', workflow_id: wf.id, trigger_reason: 'test', reason_fingerprint: 'fp',
      attempt: 1, model: 'claude-opus-4-7',
    });
    const result = dispatchResolverTool(run, {
      type: 'tool_use', id: 'u1', name: 'read_agent_log',
      input: { agent_id: 'plain-string-id', kind: 'ndjson' },
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/UUID/i);
  });

  it('rejects invalid kind values', async () => {
    const wf = await insertTestWorkflow();
    const run = queries.insertResolverRun({
      id: 'run-path-3', workflow_id: wf.id, trigger_reason: 'test', reason_fingerprint: 'fp',
      attempt: 1, model: 'claude-opus-4-7',
    });
    const result = dispatchResolverTool(run, {
      type: 'tool_use', id: 'u1', name: 'read_agent_log',
      input: { agent_id: '12345678-1234-1234-1234-123456789012', kind: 'shadow' },
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/invalid kind/);
  });

  it('rejects agent_ids that belong to a different workflow', async () => {
    const wfA = await insertTestWorkflow({ title: 'A' });
    const wfB = await insertTestWorkflow({ title: 'B' });
    // Insert a job + agent under wfB.
    const otherJob = await insertTestJob({ workflow_id: wfB.id });
    const otherAgentId = '11111111-1111-4111-8111-111111111111';
    queries.insertAgent({ id: otherAgentId, job_id: otherJob.id, status: 'failed' });

    const run = queries.insertResolverRun({
      id: 'run-cross-1', workflow_id: wfA.id, trigger_reason: 'test', reason_fingerprint: 'fp',
      attempt: 1, model: 'claude-opus-4-7',
    });
    const result = dispatchResolverTool(run, {
      type: 'tool_use', id: 'u1', name: 'read_agent_log',
      input: { agent_id: otherAgentId, kind: 'ndjson' },
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/does not belong to workflow/);
  });

  it('rejects agent_ids that do not exist at all', async () => {
    const wf = await insertTestWorkflow();
    const run = queries.insertResolverRun({
      id: 'run-cross-2', workflow_id: wf.id, trigger_reason: 'test', reason_fingerprint: 'fp',
      attempt: 1, model: 'claude-opus-4-7',
    });
    const result = dispatchResolverTool(run, {
      type: 'tool_use', id: 'u1', name: 'read_agent_log',
      input: { agent_id: '99999999-9999-4999-8999-999999999999', kind: 'ndjson' },
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/not found/);
  });
});

describe('ResolverTools — note key resolution', () => {
  beforeEach(() => setupTestDb());
  afterEach(() => cleanupTestDb());

  it('maps short forms to full keys (workflow-independent)', async () => {
    // plan/contract have no cycle component, so the workflow row doesn't
    // need to exist for these.
    const wfId = 'abc123';
    expect(resolveNoteKey(wfId, 'plan')).toBe(`workflow/${wfId}/plan`);
    expect(resolveNoteKey(wfId, 'contract')).toBe(`workflow/${wfId}/contract`);
  });

  it('parses worklog/cycle-N when the cycle is in range', async () => {
    const wf = await insertTestWorkflow({ max_cycles: 5 });
    expect(resolveNoteKey(wf.id, 'worklog/cycle-3')).toBe(`workflow/${wf.id}/worklog/cycle-3`);
  });

  it('parses review-feedback/cycle-N when the cycle is in range', async () => {
    const wf = await insertTestWorkflow({ max_cycles: 5 });
    expect(resolveNoteKey(wf.id, 'review-feedback/cycle-2')).toBe(`workflow/${wf.id}/review-feedback/cycle-2`);
  });

  it('rejects unrelated keys', () => {
    expect(resolveNoteKey('abc', 'random-key')).toBeNull();
    expect(resolveNoteKey('abc', 'workflow/different/plan')).toBeNull();
  });

  it('rejects full-form keys that bypass cycle validation', () => {
    expect(resolveNoteKey('abc', 'workflow/abc/worklog/cycle-999')).toBeNull();
    expect(resolveNoteKey('abc', 'workflow/abc/review-feedback/cycle-42')).toBeNull();
  });

  it('rejects cycle-N keys for dangling workflow IDs (no row)', () => {
    // cycleIsValid now refuses when the workflow row doesn't exist, so a
    // dangling workflow_id can't seed orphan note rows.
    expect(resolveNoteKey('does-not-exist', 'worklog/cycle-1')).toBeNull();
    expect(resolveNoteKey('does-not-exist', 'review-feedback/cycle-1')).toBeNull();
  });
});

describe('ResolverTools — write_note cycle bounds', () => {
  beforeEach(() => setupTestDb());
  afterEach(() => cleanupTestDb());

  it('rejects worklog cycles above the workflow max_cycles', async () => {
    const wf = await insertTestWorkflow({ max_cycles: 5 });
    const run = queries.insertResolverRun({
      id: 'cycle-bounds-1', workflow_id: wf.id, trigger_reason: 'test', reason_fingerprint: 'fp',
      attempt: 1, model: 'claude-opus-4-7',
    });
    const r = dispatchResolverTool(run, {
      type: 'tool_use', id: 'u', name: 'write_note',
      input: { key: 'worklog/cycle-999', value: 'should be rejected', reason: 'test' },
    });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/unrecognized note key/);
  });

  it('rejects worklog cycle 0', async () => {
    const wf = await insertTestWorkflow({ max_cycles: 5 });
    const run = queries.insertResolverRun({
      id: 'cycle-bounds-2', workflow_id: wf.id, trigger_reason: 'test', reason_fingerprint: 'fp',
      attempt: 1, model: 'claude-opus-4-7',
    });
    const r = dispatchResolverTool(run, {
      type: 'tool_use', id: 'u', name: 'write_note',
      input: { key: 'worklog/cycle-0', value: 'should be rejected', reason: 'test' },
    });
    expect(r.ok).toBe(false);
  });

  it('accepts worklog cycles within range', async () => {
    const wf = await insertTestWorkflow({ max_cycles: 5 });
    const run = queries.insertResolverRun({
      id: 'cycle-bounds-3', workflow_id: wf.id, trigger_reason: 'test', reason_fingerprint: 'fp',
      attempt: 1, model: 'claude-opus-4-7',
    });
    const r = dispatchResolverTool(run, {
      type: 'tool_use', id: 'u', name: 'write_note',
      input: { key: 'worklog/cycle-3', value: 'within-range cycle worklog', reason: 'test' },
    });
    expect(r.ok).toBe(true);
  });

  it('rejects review-feedback cycles above the workflow max_cycles', async () => {
    const wf = await insertTestWorkflow({ max_cycles: 4 });
    const run = queries.insertResolverRun({
      id: 'cycle-bounds-4', workflow_id: wf.id, trigger_reason: 'test', reason_fingerprint: 'fp',
      attempt: 1, model: 'claude-opus-4-7',
    });
    const r = dispatchResolverTool(run, {
      type: 'tool_use', id: 'u', name: 'write_note',
      input: { key: 'review-feedback/cycle-100', value: 'rejected', reason: 'test' },
    });
    expect(r.ok).toBe(false);
  });
});

describe('ResolverTools — text sanitization', () => {
  it('caps long strings with an ellipsis', () => {
    const s = 'a'.repeat(2000);
    const out = capUntrustedText(s, 100);
    expect(out.length).toBe(100);
    expect(out.endsWith('…')).toBe(true);
  });

  it('strips control characters', () => {
    const s = 'hello\x00\x07world\x1b[31m';
    const out = capUntrustedText(s, 1000);
    expect(out).not.toMatch(/[\x00-\x08\x1b]/);
  });

  it('handles null/undefined gracefully', () => {
    expect(capUntrustedText(null as unknown as string, 100)).toBe('');
    expect(capUntrustedText(undefined as unknown as string, 100)).toBe('');
  });
});

describe('ResolverTools — update_workflow_field allowlist', () => {
  beforeEach(() => setupTestDb());
  afterEach(() => cleanupTestDb());

  it('rejects work_dir updates (removed from allowlist)', async () => {
    const wf = await insertTestWorkflow({ work_dir: '/tmp/wf-test' });
    const run = queries.insertResolverRun({
      id: 'wf-field-1', workflow_id: wf.id, trigger_reason: 'test', reason_fingerprint: 'fp',
      attempt: 1, model: 'claude-opus-4-7',
    });
    const result = dispatchResolverTool(run, {
      type: 'tool_use', id: 'u1', name: 'update_workflow_field',
      input: { field: 'work_dir', value: '/etc', reason: 'should be blocked' },
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/not allowed/);
  });

  it('accepts implementer_model updates', async () => {
    const wf = await insertTestWorkflow();
    const run = queries.insertResolverRun({
      id: 'wf-field-2', workflow_id: wf.id, trigger_reason: 'test', reason_fingerprint: 'fp',
      attempt: 1, model: 'claude-opus-4-7',
    });
    const result = dispatchResolverTool(run, {
      type: 'tool_use', id: 'u1', name: 'update_workflow_field',
      input: { field: 'implementer_model', value: 'claude-sonnet-4-6', reason: 'fall back from rate-limited model' },
    });
    expect(result.ok).toBe(true);
    const refreshed = queries.getWorkflowById(wf.id);
    expect(refreshed?.implementer_model).toBe('claude-sonnet-4-6');
  });

  it('strips control chars from blocked_reason before writing to the DB', async () => {
    const wf = await insertTestWorkflow();
    const run = queries.insertResolverRun({
      id: 'wf-field-3', workflow_id: wf.id, trigger_reason: 'test', reason_fingerprint: 'fp',
      attempt: 1, model: 'claude-opus-4-7',
    });
    const ansiBomb = `\x1b[31mhostile\x1b[0m with control chars`;
    const result = dispatchResolverTool(run, {
      type: 'tool_use', id: 'u', name: 'update_workflow_field',
      input: { field: 'blocked_reason', value: ansiBomb, reason: 'inject' },
    });
    expect(result.ok).toBe(true);
    const refreshed = queries.getWorkflowById(wf.id);
    // Persisted value must be free of C0 + ANSI ESC bytes.
    expect(refreshed?.blocked_reason ?? '').not.toMatch(/[\x00-\x08\x0E-\x1F]/);
    expect(refreshed?.blocked_reason ?? '').toContain('hostile');
  });
});

describe('ResolverTools — write_note sanitizes value', () => {
  beforeEach(() => setupTestDb());
  afterEach(() => cleanupTestDb());

  it('strips control chars from note value before upserting', async () => {
    const wf = await insertTestWorkflow({ max_cycles: 5 });
    const run = queries.insertResolverRun({
      id: 'note-strip-1', workflow_id: wf.id, trigger_reason: 'test', reason_fingerprint: 'fp',
      attempt: 1, model: 'claude-opus-4-7',
    });
    const dirty = `plan content\x1b[31mwith ANSI\x1b[0m and a bell`;
    const r = dispatchResolverTool(run, {
      type: 'tool_use', id: 'u', name: 'write_note',
      input: { key: 'plan', value: dirty, reason: 'inject' },
    });
    expect(r.ok).toBe(true);
    const note = queries.getNote(`workflow/${wf.id}/plan`);
    expect(note).not.toBeNull();
    expect(note!.value).not.toMatch(/[\x00-\x08\x0E-\x1F]/);
    expect(note!.value).toContain('plan content');
  });
});

describe('ResolverTools — git verb allowlist', () => {
  it('allows safe verbs', () => {
    for (const v of ['add', 'commit', 'restore', 'stash', 'status', 'diff', 'log']) {
      expect(ALLOWED_GIT_VERBS.has(v)).toBe(true);
    }
  });

  it('blocks destructive verbs', () => {
    for (const v of ['push', 'reset', 'clean', 'branch', 'checkout', 'merge', 'rebase']) {
      expect(ALLOWED_GIT_VERBS.has(v)).toBe(false);
    }
  });
});

describe('ResolverTools — dispatcher', () => {
  beforeEach(() => setupTestDb());
  afterEach(() => cleanupTestDb());

  it('rejects unknown tool names', async () => {
    const wf = await insertTestWorkflow({ work_dir: '/tmp/wf-test' });
    const run = queries.insertResolverRun({
      id: 'run-1', workflow_id: wf.id, trigger_reason: 'test', reason_fingerprint: 'fp1',
      attempt: 1, model: 'claude-opus-4-7',
    });
    const result = dispatchResolverTool(run, {
      type: 'tool_use', id: 'use-1', name: 'totally_made_up', input: {},
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/unknown tool/);
  });
});

describe('ResolverTools — git_command in a real worktree', () => {
  let tmpDir: string;

  beforeEach(async () => {
    await setupTestDb();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resolver-test-'));
    execFileSync('git', ['init', '-b', 'main'], { cwd: tmpDir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tmpDir });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir });
    fs.writeFileSync(path.join(tmpDir, 'README.md'), 'hello\n');
    execFileSync('git', ['add', 'README.md'], { cwd: tmpDir });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: tmpDir });
  });

  afterEach(async () => {
    await cleanupTestDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('allows git status', async () => {
    const wf = await insertTestWorkflow({ work_dir: tmpDir });
    const run = queries.insertResolverRun({
      id: 'run-1', workflow_id: wf.id, trigger_reason: 'test', reason_fingerprint: 'fp1',
      attempt: 1, model: 'claude-opus-4-7',
    });
    const result = dispatchResolverTool(run, {
      type: 'tool_use', id: 'u1', name: 'git_command',
      input: { args: ['status', '--short'], reason: 'check status' },
    });
    expect(result.ok).toBe(true);
  });

  it('blocks git push', async () => {
    const wf = await insertTestWorkflow({ work_dir: tmpDir });
    const run = queries.insertResolverRun({
      id: 'run-2', workflow_id: wf.id, trigger_reason: 'test', reason_fingerprint: 'fp2',
      attempt: 1, model: 'claude-opus-4-7',
    });
    const result = dispatchResolverTool(run, {
      type: 'tool_use', id: 'u2', name: 'git_command',
      input: { args: ['push', 'origin', 'main'], reason: 'push' },
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/not in the allowlist/);
  });

  it('allows git stash and git stash pop', async () => {
    const wf = await insertTestWorkflow({ work_dir: tmpDir });
    const run = queries.insertResolverRun({
      id: 'run-stash-ok', workflow_id: wf.id, trigger_reason: 'test', reason_fingerprint: 'fp-stash',
      attempt: 1, model: 'claude-opus-4-7',
    });
    // Make a dirty change so stash has something to capture.
    fs.writeFileSync(path.join(tmpDir, 'dirty.txt'), 'wip\n');
    execFileSync('git', ['add', 'dirty.txt'], { cwd: tmpDir });
    const stash = dispatchResolverTool(run, {
      type: 'tool_use', id: 'u-stash', name: 'git_command',
      input: { args: ['stash', 'push', '-m', 'wip'], reason: 'stash' },
    });
    expect(stash.ok).toBe(true);
    const pop = dispatchResolverTool(run, {
      type: 'tool_use', id: 'u-pop', name: 'git_command',
      input: { args: ['stash', 'pop'], reason: 'pop' },
    });
    expect(pop.ok).toBe(true);
  });

  it('blocks git stash drop', async () => {
    const wf = await insertTestWorkflow({ work_dir: tmpDir });
    const run = queries.insertResolverRun({
      id: 'run-stash-drop', workflow_id: wf.id, trigger_reason: 'test', reason_fingerprint: 'fp-drop',
      attempt: 1, model: 'claude-opus-4-7',
    });
    const r = dispatchResolverTool(run, {
      type: 'tool_use', id: 'u-drop', name: 'git_command',
      input: { args: ['stash', 'drop'], reason: 'drop' },
    });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/discard stashed work/);
  });

  it('blocks git stash clear', async () => {
    const wf = await insertTestWorkflow({ work_dir: tmpDir });
    const run = queries.insertResolverRun({
      id: 'run-stash-clear', workflow_id: wf.id, trigger_reason: 'test', reason_fingerprint: 'fp-clear',
      attempt: 1, model: 'claude-opus-4-7',
    });
    const r = dispatchResolverTool(run, {
      type: 'tool_use', id: 'u-clear', name: 'git_command',
      input: { args: ['stash', 'clear'], reason: 'clear' },
    });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/discard stashed work/);
  });

  it('blocks git commit --amend', async () => {
    const wf = await insertTestWorkflow({ work_dir: tmpDir });
    const run = queries.insertResolverRun({
      id: 'run-3', workflow_id: wf.id, trigger_reason: 'test', reason_fingerprint: 'fp3',
      attempt: 1, model: 'claude-opus-4-7',
    });
    const result = dispatchResolverTool(run, {
      type: 'tool_use', id: 'u3', name: 'git_command',
      input: { args: ['commit', '--amend', '-m', 'oops'], reason: 'amend' },
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/--amend/);
  });

  it('edits a worktree file and rejects writes outside the worktree', async () => {
    const wf = await insertTestWorkflow({ work_dir: tmpDir });
    const run = queries.insertResolverRun({
      id: 'run-4', workflow_id: wf.id, trigger_reason: 'test', reason_fingerprint: 'fp4',
      attempt: 1, model: 'claude-opus-4-7',
    });
    const ok = dispatchResolverTool(run, {
      type: 'tool_use', id: 'u4', name: 'edit_worktree_file',
      input: { path: 'src/new.ts', contents: 'export const x = 1;\n', reason: 'add new file' },
    });
    expect(ok.ok).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'src', 'new.ts'))).toBe(true);

    const bad = dispatchResolverTool(run, {
      type: 'tool_use', id: 'u5', name: 'edit_worktree_file',
      input: { path: '../escape.ts', contents: 'nope', reason: 'try to escape' },
    });
    expect(bad.ok).toBe(false);
  });

  it('refuses to overwrite a file currently held by an active file lock', async () => {
    const wf = await insertTestWorkflow({ work_dir: tmpDir });
    const run = queries.insertResolverRun({
      id: 'run-lock', workflow_id: wf.id, trigger_reason: 'test', reason_fingerprint: 'fp-lock',
      attempt: 1, model: 'claude-opus-4-7',
    });

    // Insert a job + agent so the lock has a valid agent_id reference, then
    // grab a lock on a file we're about to ask the Resolver to edit.
    const otherJob = await insertTestJob({ workflow_id: wf.id });
    const otherAgentId = '22222222-2222-4222-8222-222222222222';
    queries.insertAgent({ id: otherAgentId, job_id: otherJob.id, status: 'running' });
    const target = path.join(tmpDir, 'guarded.ts');
    queries.insertFileLock({
      id: 'lock-1',
      agent_id: otherAgentId,
      file_path: target,
      reason: 'mid-edit',
      acquired_at: Date.now(),
      expires_at: Date.now() + 60_000,
      released_at: null,
    });

    const r = dispatchResolverTool(run, {
      type: 'tool_use', id: 'u-lock', name: 'edit_worktree_file',
      input: { path: 'guarded.ts', contents: 'export const x = 1;\n', reason: 'try to edit a locked file' },
    });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/locked by agent/);
    expect(fs.existsSync(target)).toBe(false);
  });

  it('rejects a write through a symlink that escapes the worktree', async () => {
    const wf = await insertTestWorkflow({ work_dir: tmpDir });
    const run = queries.insertResolverRun({
      id: 'run-symlink-1', workflow_id: wf.id, trigger_reason: 'test', reason_fingerprint: 'fp-sym',
      attempt: 1, model: 'claude-opus-4-7',
    });
    // Create a symlink inside the worktree that points to an external dir.
    const escapeTarget = fs.mkdtempSync(path.join(os.tmpdir(), 'resolver-escape-'));
    fs.symlinkSync(escapeTarget, path.join(tmpDir, 'escaping'));
    try {
      const bad = dispatchResolverTool(run, {
        type: 'tool_use', id: 'u-sym', name: 'edit_worktree_file',
        input: { path: 'escaping/owned.ts', contents: 'pwned', reason: 'attempt symlink escape' },
      });
      expect(bad.ok).toBe(false);
      expect(bad.message).toMatch(/symlink/);
      expect(fs.existsSync(path.join(escapeTarget, 'owned.ts'))).toBe(false);
    } finally {
      fs.rmSync(escapeTarget, { recursive: true, force: true });
    }
  });
});
