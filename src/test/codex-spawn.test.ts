/**
 * Tests that Codex agents receive the prompt as a positional argument
 * (not via stdin) to prevent the "Reading prompt from stdin..." hang.
 *
 * When Codex receives the prompt via stdin pipe, it processes it, then
 * loops back to read another prompt. Even after stdin.end(), Codex hangs
 * on "Reading prompt from stdin..." instead of exiting. Passing the prompt
 * as a positional arg to `codex exec <prompt>` avoids this entirely.
 */
import { describe, it, expect } from 'vitest';
import { isCodexModel, codexModelName } from '../shared/types.js';
import { getCodexReasoningEffort } from '../shared/models.js';

describe('Codex spawn args', () => {
  /**
   * Simulate the arg-building logic from AgentRunner.runAgent() to verify
   * the prompt ends up as a positional argument for Codex models.
   */
  function buildCodexArgs(model: string, prompt: string, workDir: string): string[] {
    const codexSubModel = codexModelName(model);
    const codexReasoningEffort = getCodexReasoningEffort(model);
    return [
      'exec',
      '--json',
      '--dangerously-bypass-approvals-and-sandbox',
      '-C', workDir,
      '--skip-git-repo-check',
      '-c', `mcp_servers.orchestrator.url="http://localhost:3947/mcp/test"`,
      ...(codexSubModel ? ['-m', codexSubModel] : []),
      ...(codexReasoningEffort ? ['-c', `model_reasoning_effort="${codexReasoningEffort}"`] : []),
      // Prompt must be the last positional arg
      prompt,
    ];
  }

  it('codex models are identified correctly', () => {
    expect(isCodexModel('codex')).toBe(true);
    expect(isCodexModel('codex-gpt-5.5')).toBe(true);
    expect(isCodexModel('claude-sonnet-4-6')).toBe(false);
    expect(isCodexModel(null)).toBe(false);
  });

  it('prompt is included as the last positional argument for codex', () => {
    const prompt = 'Review the code and check for issues';
    const args = buildCodexArgs('codex', prompt, '/tmp/repo');

    // The prompt must be the last element in the args array
    expect(args[args.length - 1]).toBe(prompt);
    // And it must appear exactly once
    expect(args.filter(a => a === prompt)).toHaveLength(1);
  });

  it('prompt is included as the last arg even with a sub-model', () => {
    const prompt = 'Implement the feature';
    const args = buildCodexArgs('codex-gpt-5.5', prompt, '/tmp/repo');

    expect(args[args.length - 1]).toBe(prompt);
    // Sub-model flag should be present
    expect(args).toContain('-m');
    expect(args).toContain('gpt-5.5');
    expect(args).toContain('model_reasoning_effort="xhigh"');
    // Prompt comes after the model flag
    const modelIdx = args.indexOf('gpt-5.5');
    const promptIdx = args.indexOf(prompt);
    expect(promptIdx).toBeGreaterThan(modelIdx);
  });

  it('adds xhigh reasoning effort for codex sessions', () => {
    const args = buildCodexArgs('codex', 'Review the diff', '/tmp/repo');
    expect(args).toContain('-c');
    expect(args).toContain('model_reasoning_effort="xhigh"');
  });

  it('prompt with special characters is passed as a single arg', () => {
    const prompt = 'Fix the bug in src/server/api/router.ts\n\n## Context\n- Line 42 has an off-by-one error\n- "quotes" and $variables should be safe';
    const args = buildCodexArgs('codex', prompt, '/tmp/repo');

    // The entire prompt is one array element (not split)
    expect(args[args.length - 1]).toBe(prompt);
  });

  it('stdin should NOT receive prompt for codex models', () => {
    // This tests the logical condition used in AgentRunner:
    // if (!useCodex) { child.stdin.write(prompt); }
    const model = 'codex';
    const useCodex = isCodexModel(model);
    expect(useCodex).toBe(true);

    // For claude models, stdin IS used
    const claudeModel = 'claude-sonnet-4-6';
    const useCodexForClaude = isCodexModel(claudeModel);
    expect(useCodexForClaude).toBe(false);
  });
});
