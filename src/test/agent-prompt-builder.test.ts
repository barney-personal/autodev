import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from '../shared/types.js';

// Mock the data-access and config layers so buildPrompt is exercised in
// isolation (no DB, no filesystem CLAUDE.md read). isCodexModel is the real
// pure helper from shared/types.
vi.mock('../server/db/queries.js', () => ({
  getTemplateById: vi.fn(() => null),
}));

vi.mock('../server/orchestrator/AgentConfig.js', () => ({
  SYSTEM_PROMPT: 'SYSTEM_PROMPT_MARKER',
  readClaudeMd: vi.fn(() => null),
  buildMemorySection: vi.fn(() => '\n\n[MEMORY]'),
}));

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    title: 'My Title',
    description: 'Do the thing',
    status: 'running',
    model: 'claude-opus-4-8',
    retry_count: 0,
    created_at: 0,
    updated_at: 0,
    context: null,
    template_id: null,
    pre_debate_summary: null,
    work_dir: '/tmp/repo',
    project_id: null,
    ...overrides,
  } as Job;
}

describe('AgentPromptBuilder.buildPrompt', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('builds a basic Claude prompt without the system-prompt preamble', async () => {
    const { readClaudeMd } = await import('../server/orchestrator/AgentConfig.js');
    const { buildPrompt } = await import('../server/orchestrator/AgentPromptBuilder.js');

    const prompt = buildPrompt(makeJob());

    expect(prompt).not.toContain('SYSTEM_PROMPT_MARKER');
    expect(prompt.startsWith('# Task: My Title\n\n')).toBe(true);
    expect(prompt).toContain('Do the thing');
    // Non-codex models never read CLAUDE.md.
    expect(readClaudeMd).not.toHaveBeenCalled();
    // Memory section is always appended last.
    expect(prompt.endsWith('[MEMORY]')).toBe(true);
  });

  it('prepends the system prompt and injects CLAUDE.md for codex models', async () => {
    const { readClaudeMd } = await import('../server/orchestrator/AgentConfig.js');
    vi.mocked(readClaudeMd).mockReturnValue('PROJECT_RULES');
    const { buildPrompt } = await import('../server/orchestrator/AgentPromptBuilder.js');

    const prompt = buildPrompt(makeJob({ model: 'codex', work_dir: '/tmp/repo' }));

    expect(prompt.startsWith('SYSTEM_PROMPT_MARKER\n\n---\n\n')).toBe(true);
    expect(readClaudeMd).toHaveBeenCalledWith('/tmp/repo');
    expect(prompt).toContain('## Project Instructions (from CLAUDE.md)\n\nPROJECT_RULES');
  });

  it('omits the CLAUDE.md section for codex when readClaudeMd returns null', async () => {
    const { readClaudeMd } = await import('../server/orchestrator/AgentConfig.js');
    vi.mocked(readClaudeMd).mockReturnValue(null);
    const { buildPrompt } = await import('../server/orchestrator/AgentPromptBuilder.js');

    const prompt = buildPrompt(makeJob({ model: 'codex-mini' }));

    expect(prompt.startsWith('SYSTEM_PROMPT_MARKER')).toBe(true);
    expect(prompt).not.toContain('## Project Instructions');
  });

  it('inserts the pre-debate summary ahead of the original task', async () => {
    const { buildPrompt } = await import('../server/orchestrator/AgentPromptBuilder.js');

    const prompt = buildPrompt(makeJob({ pre_debate_summary: 'CONSENSUS SUMMARY' }));

    expect(prompt).toContain('CONSENSUS SUMMARY\n\n## Original Task\n');
  });

  it('renders template guidelines and a task-description header when both are present', async () => {
    const queries = await import('../server/db/queries.js');
    vi.mocked(queries.getTemplateById).mockReturnValue({
      id: 't1',
      name: 'tpl',
      content: 'GUIDELINE_BODY',
    } as any);
    const { buildPrompt } = await import('../server/orchestrator/AgentPromptBuilder.js');

    const prompt = buildPrompt(makeJob({ template_id: 't1', description: 'Do the thing' }));

    expect(queries.getTemplateById).toHaveBeenCalledWith('t1');
    expect(prompt).toContain('## Guidelines\n\nGUIDELINE_BODY');
    expect(prompt).toContain('## Task Description\n\n');
    expect(prompt).toContain('Do the thing');
  });

  it('skips the task-description header when the template is present but description is blank', async () => {
    const queries = await import('../server/db/queries.js');
    vi.mocked(queries.getTemplateById).mockReturnValue({
      id: 't1',
      name: 'tpl',
      content: 'GUIDELINE_BODY',
    } as any);
    const { buildPrompt } = await import('../server/orchestrator/AgentPromptBuilder.js');

    const prompt = buildPrompt(makeJob({ template_id: 't1', description: '   ' }));

    expect(prompt).toContain('## Guidelines\n\nGUIDELINE_BODY');
    expect(prompt).not.toContain('## Task Description');
  });

  it('renders additional context bullets from a JSON context object', async () => {
    const { buildPrompt } = await import('../server/orchestrator/AgentPromptBuilder.js');

    const prompt = buildPrompt(makeJob({ context: JSON.stringify({ pr: 39, repo: 'autodev' }) }));

    expect(prompt).toContain('## Additional Context\n');
    expect(prompt).toContain('- **pr**: 39\n');
    expect(prompt).toContain('- **repo**: autodev\n');
  });

  it('ignores an unparseable context string without throwing', async () => {
    const { buildPrompt } = await import('../server/orchestrator/AgentPromptBuilder.js');

    const prompt = buildPrompt(makeJob({ context: 'not-json{' }));

    expect(prompt).not.toContain('## Additional Context');
    expect(prompt).toContain('Do the thing');
  });
});
