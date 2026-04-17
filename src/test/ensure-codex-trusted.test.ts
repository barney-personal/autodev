/**
 * Tests for ensureCodexTrusted: adding a directory to codex's config.toml as
 * trusted, and self-healing duplicate `[projects."..."]` sections that arise
 * from concurrent spawns racing between read-check and append-write.
 *
 * Prior bug: concurrent ensureCodexTrusted calls all observed the key absent,
 * all appended, producing N duplicate sections. On the next codex launch,
 * codex aborted with a duplicate-key TOML parse error, which manifested as
 * workflow review phases silently failing to spawn.
 *
 * Fix: the function now dedupes on every call. Any past damage heals on the
 * next invocation; future races are idempotent (subsequent calls collapse
 * duplicates back to one).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ensureCodexTrusted, _resetTrustedCacheForTests } from '../server/orchestrator/AgentConfig.js';

describe('ensureCodexTrusted', () => {
  let tmpHome: string;
  let originalHome: string | undefined;
  let configPath: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-trust-test-'));
    originalHome = process.env.HOME;
    process.env.HOME = tmpHome;
    configPath = path.join(tmpHome, '.codex', 'config.toml');
    _resetTrustedCacheForTests();
  });

  afterEach(() => {
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('creates config.toml with a new trusted section when the file does not exist', () => {
    ensureCodexTrusted('/some/work/dir');
    const content = fs.readFileSync(configPath, 'utf8');
    expect(content).toContain('[projects."/some/work/dir"]');
    expect(content).toContain('trust_level = "trusted"');
  });

  it('does not duplicate an existing section on repeated calls', () => {
    ensureCodexTrusted('/some/work/dir');
    ensureCodexTrusted('/some/work/dir');
    ensureCodexTrusted('/some/work/dir');
    const content = fs.readFileSync(configPath, 'utf8');
    const matches = content.match(/\[projects\."\/some\/work\/dir"\]/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it('dedupes pre-existing duplicate sections (self-heals past races)', () => {
    // Simulate a file with 5 duplicate sections — the result of past races.
    const damaged =
      `# preamble\n` +
      `[projects."/foo"]\ntrust_level = "trusted"\n\n`.repeat(5) +
      `[projects."/bar"]\ntrust_level = "trusted"\n`;
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, damaged);

    ensureCodexTrusted('/foo');

    const content = fs.readFileSync(configPath, 'utf8');
    const fooMatches = content.match(/\[projects\."\/foo"\]/g) ?? [];
    const barMatches = content.match(/\[projects\."\/bar"\]/g) ?? [];
    expect(fooMatches.length).toBe(1);
    // Unrelated sections must be preserved
    expect(barMatches.length).toBe(1);
    expect(content).toContain('trust_level = "trusted"');
  });

  it('preserves other project sections when deduping one key', () => {
    const existing =
      `[projects."/a"]\ntrust_level = "trusted"\n\n` +
      `[projects."/dup"]\ntrust_level = "trusted"\n\n` +
      `[projects."/b"]\ntrust_level = "trusted"\n\n` +
      `[projects."/dup"]\ntrust_level = "trusted"\n\n` +
      `[projects."/c"]\ntrust_level = "trusted"\n`;
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, existing);

    ensureCodexTrusted('/dup');

    const content = fs.readFileSync(configPath, 'utf8');
    expect((content.match(/\[projects\."\/dup"\]/g) ?? []).length).toBe(1);
    // All others intact
    for (const key of ['/a', '/b', '/c']) {
      const re = new RegExp(`\\[projects\\."${key}"\\]`, 'g');
      expect((content.match(re) ?? []).length).toBe(1);
    }
  });

  it('escapes regex-special characters in the workDir key', () => {
    // Paths with `.`, `+`, `(` etc. must not be treated as regex metacharacters.
    const trickyDir = '/tmp/foo.bar+(1)';
    ensureCodexTrusted(trickyDir);
    ensureCodexTrusted(trickyDir);
    ensureCodexTrusted(trickyDir);
    const content = fs.readFileSync(configPath, 'utf8');
    // Escape regex-special chars (including dots and parens) before matching.
    const escaped = trickyDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\[projects\\."${escaped}"\\]`, 'g');
    expect((content.match(re) ?? []).length).toBe(1);
  });

  it('leaves output parseable (no stray triple-newline blocks after dedupe)', () => {
    const damaged = `[projects."/x"]\ntrust_level = "trusted"\n\n`.repeat(10);
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, damaged);
    ensureCodexTrusted('/x');
    const content = fs.readFileSync(configPath, 'utf8');
    expect(content).not.toMatch(/\n{3,}/);
  });

  it('dedupes when the last section body has no trailing newline', () => {
    // Simulates a hand-edited file: last body line missing its trailing \n.
    // Before the normalization fix, dedupe would capture only the second
    // section's header and leave the `trust_level = "trusted"` body orphaned.
    const damaged =
      `[projects."/y"]\ntrust_level = "trusted"\n\n` +
      `[projects."/y"]\ntrust_level = "trusted"`; // <- no trailing newline
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, damaged);

    ensureCodexTrusted('/y');

    const content = fs.readFileSync(configPath, 'utf8');
    const headerMatches = content.match(/\[projects\."\/y"\]/g) ?? [];
    expect(headerMatches.length).toBe(1);
    // Exactly one body line, no orphaned `trust_level` dangling at EOF.
    const bodyMatches = content.match(/trust_level = "trusted"/g) ?? [];
    expect(bodyMatches.length).toBe(1);
  });

  it('writes atomically — no .tmp files left behind on success', () => {
    // Smoke test: after a successful dedupe, no temp files should remain in
    // the config directory. (We can't easily test mid-crash behaviour, but
    // we can verify the happy path cleans up.)
    const damaged = `[projects."/z"]\ntrust_level = "trusted"\n\n`.repeat(3);
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, damaged);

    ensureCodexTrusted('/z');

    const entries = fs.readdirSync(path.dirname(configPath));
    const tmpFiles = entries.filter(name => name.startsWith('config.toml.tmp-'));
    expect(tmpFiles).toEqual([]);
  });
});
