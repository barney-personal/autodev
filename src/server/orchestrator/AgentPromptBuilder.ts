import * as queries from '../db/queries.js';
import type { Job } from '../../shared/types.js';
import { isCodexModel } from '../../shared/types.js';
import { SYSTEM_PROMPT, readClaudeMd, buildMemorySection } from './AgentConfig.js';

export function buildPrompt(job: Job): string {
  const model: string | null = job.model ?? null;
  let prompt = '';

  if (isCodexModel(model)) {
    prompt += SYSTEM_PROMPT + '\n\n---\n\n';
  }

  prompt += `# Task: ${job.title}\n\n`;

  if (job.pre_debate_summary) {
    prompt += job.pre_debate_summary + '\n\n## Original Task\n';
  }

  const templateId = job.template_id;
  if (templateId) {
    const template = queries.getTemplateById(templateId);
    if (template) {
      prompt += `## Guidelines\n\n${template.content}`;
      if (job.description.trim()) {
        prompt += `\n\n## Task Description\n\n`;
      }
    }
  }

  if (job.description.trim()) {
    prompt += job.description;
  }

  if (job.context) {
    try {
      const ctx = JSON.parse(job.context);
      prompt += '\n\n## Additional Context\n';
      for (const [k, v] of Object.entries(ctx)) {
        prompt += `- **${k}**: ${v}\n`;
      }
    } catch { /* ignore */ }
  }

  const workDir = job.work_dir ?? process.cwd();
  if (isCodexModel(model)) {
    const claudeMd = readClaudeMd(workDir);
    if (claudeMd) {
      prompt += `\n\n## Project Instructions (from CLAUDE.md)\n\n${claudeMd}`;
    }
  }

  prompt += buildMemorySection(job);

  return prompt;
}
