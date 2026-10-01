/** Paid, opt-in acceptance test against a local running Autodev instance. */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const base = process.env.AUTODEV_URL || 'http://127.0.0.1:3456';
const model = process.env.SMOKE_MODEL || 'claude-opus-5-5';
const headers = { 'Content-Type': 'application/json', ...(process.env.AUTH_TOKEN ? { Authorization: `Bearer ${process.env.AUTH_TOKEN}` } : {}) };
async function api(path, options = {}) {
  const response = await fetch(base + path, { headers, signal: AbortSignal.timeout(10000), ...options });
  assert.ok(response.ok, `HTTP ${response.status}: ${path}`);
  return response.json();
}
const dir = mkdtempSync(join(tmpdir(), 'autodev-acceptance-'));
writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module', scripts: { test: 'node --test' } }));
writeFileSync(join(dir, 'clamp.js'), 'export function clamp(value, min, max) { return value; }\n');
writeFileSync(join(dir, 'clamp.test.js'), `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clamp } from './clamp.js';
test('clamps below, inside and above bounds', () => {
  assert.equal(clamp(-1, 0, 10), 0);
  assert.equal(clamp(4, 0, 10), 4);
  assert.equal(clamp(20, 0, 10), 10);
});\n`);
writeFileSync(join(dir, 'AGENTS.md'), 'Isolated acceptance fixture. Work only here. No network access or delegation. Use orchestrator MCP to report completion.\n');
execFileSync('git', ['init', '-q'], { cwd: dir });
execFileSync('git', ['add', '.'], { cwd: dir });
execFileSync('git', ['-c', 'user.name=Autodev Test', '-c', 'user.email=test@localhost', 'commit', '-qm', 'Acceptance fixture'], { cwd: dir });
const created = await api('/api/tasks', { method: 'POST', body: JSON.stringify({
  title: `Acceptance: ${model}`, preset: 'quick', model, workDir: dir,
  useWorktree: false, stopMode: 'time', stopValue: 5,
  description: 'Fix clamp.js so the provided tests pass. Work only in this fixture; no network or delegation. Do not edit tests. Run npm test, then write the result through orchestrator MCP write_note and finish_job. Do not commit or create a PR.',
}) });
const id = created.job.id;
console.log(JSON.stringify({ event: 'started', id, model, dir }));
let complete = false;
try {
  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    const job = await api(`/api/jobs/${id}`);
    if (job.status === 'done') {
      execFileSync('npm', ['test'], { cwd: dir, stdio: 'pipe', timeout: 30000 });
      const changed = execFileSync('git', ['diff', '--name-only'], { cwd: dir, encoding: 'utf8' }).trim();
      assert.equal(changed, 'clamp.js', 'only the implementation should change');
      complete = true;
      console.log(JSON.stringify({ event: 'passed', id, requestedModel: model, effectiveModel: job.model, dir }));
      break;
    }
    assert.ok(!['failed', 'cancelled'].includes(job.status), `Job ${id} ended ${job.status}`);
    await delay(2000);
  }
  assert.ok(complete, `Job ${id} timed out`);
} finally {
  if (!complete) await api(`/api/jobs/${id}`, { method: 'DELETE' }).catch(() => {});
}
