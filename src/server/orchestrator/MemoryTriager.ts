import { randomUUID } from 'crypto';
import { captureWithContext } from '../instrument.js';
import * as queries from '../db/queries.js';
import type { Job, KBEntry } from '../../shared/types.js';

const TRIAGE_MODEL = 'claude-haiku-4-5-20251001';

interface Learning {
  title: string;
  content: string;
  tags?: string;
  scope?: 'project' | 'global';
}

interface TriageResult {
  index: number;
  classification: 'project' | 'global' | 'discard';
  supersedes?: string; // ID of existing entry this learning improves on
}

/**
 * Called after a job completes successfully. Reads any learnings the agent
 * reported via report_learnings, triages them through Haiku, and stores
 * survivors in the knowledge_base table.
 */
export async function triageLearnings(agentId: string, job: Job): Promise<void> {
  const noteKey = `_learnings/${agentId}`;
  const note = queries.getNote(noteKey);
  if (!note) return;

  let learnings: Learning[];
  try {
    learnings = JSON.parse(note.value);
    if (!Array.isArray(learnings) || learnings.length === 0) {
      queries.deleteNote(noteKey);
      return;
    }
  } catch {
    queries.deleteNote(noteKey);
    return;
  }

  const projectId: string | null = job.project_id ?? null;
  const workDir: string | null = job.work_dir ?? null;
  // Use work_dir as fallback scoping key so learnings from different codebases don't mix
  const effectiveProjectId: string | null = projectId ?? workDir ?? null;

  // Find similar existing KB entries using FTS on each learning's title
  const candidates = findCandidateMatches(learnings, effectiveProjectId);

  let classifications: TriageResult[];
  try {
    classifications = await classifyLearnings(learnings, candidates, job.title, workDir);
  } catch (err) {
    console.error(`[memory-triage] API call failed for agent ${agentId}, storing all as project-scoped:`, err);
    captureWithContext(err, { agent_id: agentId, job_id: job.id, component: 'MemoryTriager' });
    classifications = learnings.map((_, i) => ({ index: i, classification: 'project' as const }));
  }

  let stored = 0;
  let updated = 0;
  for (const result of classifications) {
    if (result.classification === 'discard') continue;
    const learning = learnings[result.index];
    if (!learning) continue;

    const entryProjectId = result.classification === 'global' ? null : effectiveProjectId;

    // If this learning supersedes an existing entry, update it instead of creating a duplicate
    if (result.supersedes) {
      const existing = queries.getKBEntryById(result.supersedes);
      if (existing) {
        queries.updateKBEntry(result.supersedes, {
          title: learning.title,
          content: learning.content,
          tags: learning.tags ?? existing.tags,
        });
        updated++;
        continue;
      }
    }

    queries.insertKBEntry({
      id: randomUUID(),
      title: learning.title,
      content: learning.content,
      tags: learning.tags ?? null,
      source: `agent:${agentId}`,
      agent_id: agentId,
      project_id: entryProjectId,
    });
    stored++;
  }

  // Clean up transient note
  queries.deleteNote(noteKey);

  if (stored > 0 || updated > 0) {
    console.log(`[memory-triage] agent ${agentId}: stored ${stored}, updated ${updated}/${learnings.length} learnings`);
  }
}

interface CandidateEntry {
  id: string;
  title: string;
  excerpt: string; // first ~200 chars of content
}

/**
 * For each incoming learning, search the KB via FTS to find semantically similar
 * existing entries. Returns a flat list of candidates with content excerpts.
 */
function findCandidateMatches(learnings: Learning[], projectId: string | null): CandidateEntry[] {
  const seen = new Set<string>();
  const candidates: CandidateEntry[] = [];

  for (const learning of learnings) {
    try {
      const results = queries.searchKB(learning.title, projectId ?? undefined, 5);
      for (const r of results) {
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        candidates.push({
          id: r.id,
          title: r.title,
          excerpt: r.content.slice(0, 200),
        });
      }
    } catch { /* FTS error — skip */ }
  }

  return candidates.slice(0, 30); // cap context size
}

async function classifyLearnings(
  learnings: Learning[],
  candidates: CandidateEntry[],
  jobTitle: string,
  workDir?: string | null,
): Promise<TriageResult[]> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return learnings.map((_, i) => ({ index: i, classification: 'project' as const }));
  }

  const learningsList = learnings.map((l, i) =>
    `${i}. "${l.title}": ${l.content.slice(0, 200)}${l.scope ? ` [hint: ${l.scope}]` : ''}`
  ).join('\n');

  const existingList = candidates.length > 0
    ? `\nExisting KB entries (check for duplicates — compare CONTENT, not just titles):\n${candidates.map(c => `- [${c.id}] "${c.title}": ${c.excerpt}`).join('\n')}`
    : '';

  const workDirLine = workDir ? `\nCodebase directory: ${workDir}` : '';

  const prompt = `You are triaging learnings from an AI coding agent into a knowledge base.
Job completed: "${jobTitle}"${workDirLine}

Learnings to classify:
${learningsList}
${existingList}

For each learning, classify as:
- "project" — specific to this codebase (build commands, file locations, API quirks, project conventions, tool/framework patterns specific to this project)
- "global" — useful across ANY codebase regardless of language or framework (e.g., git strategies, general debugging principles)
- "discard" — too vague, trivially obvious, or duplicates an existing entry

IMPORTANT: When in doubt, classify as "project" not "global". Only use "global" for knowledge that would genuinely apply to a completely unrelated codebase. If a learning mentions specific tools, frameworks, services, or directories from this project, it is "project"-scoped.

Two entries are duplicates if they encode the SAME fact, even if worded differently.
If a new learning improves on or updates an existing entry, set "supersedes" to that entry's ID
instead of discarding — the existing entry will be updated with the new content.

Respond with ONLY a JSON array like:
[{"index":0,"classification":"project"},{"index":1,"classification":"discard"},{"index":2,"classification":"project","supersedes":"existing-entry-id"}]`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal: controller.signal,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: TRIAGE_MODEL,
      max_tokens: 512,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  clearTimeout(timeout);

  if (!response.ok) {
    throw new Error(`Anthropic API ${response.status}: ${await response.text()}`);
  }

  const data = await response.json() as { content?: Array<{ text?: string }> };
  const text = (data.content?.[0]?.text ?? '').trim();

  const match = text.match(/\[[\s\S]*\]/);
  if (!match) {
    throw new Error(`Could not parse triage response: ${text.slice(0, 200)}`);
  }

  const results: TriageResult[] = JSON.parse(match[0]);
  const resultMap = new Map(results.map(r => [r.index, r]));
  return learnings.map((_, i) => resultMap.get(i) ?? { index: i, classification: 'project' as const });
}
