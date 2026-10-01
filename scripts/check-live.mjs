import assert from 'node:assert/strict';
const base = process.env.AUTODEV_URL || `http://127.0.0.1:${process.env.PORT || 3456}`;
const headers = process.env.AUTH_TOKEN ? { Authorization: `Bearer ${process.env.AUTH_TOKEN}` } : {};
const healthResponse = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(10000) });
assert.equal(healthResponse.status, 200, 'health check');
const health = await healthResponse.json();
assert.equal(health.checks.db.status, 'ok', 'database ready');
assert.ok(health.release?.revision, 'build revision present');
const page = await fetch(base, { signal: AbortSignal.timeout(10000) });
assert.equal(page.status, 200, 'dashboard served');
assert.match(await page.text(), /<div id="root"><\/div>/, 'dashboard HTML');
const modelsResponse = await fetch(`${base}/api/models`, { headers, signal: AbortSignal.timeout(10000) });
assert.equal(modelsResponse.status, 200, 'authenticated API');
const models = await modelsResponse.json();
assert.ok(models.claude.some(m => m.value === 'claude-opus-5-5'), 'current Claude catalog');
assert.ok(models.codex.length > 1, 'Codex catalog');
if (process.env.AUTH_TOKEN) {
  const anonymous = await fetch(`${base}/api/models`);
  assert.equal(anonymous.status, 401, 'anonymous API is protected');
}
console.log(JSON.stringify({ url: base, revision: health.release.revision, status: health.status, catalogSource: models.source, checks: 'passed' }, null, 2));
