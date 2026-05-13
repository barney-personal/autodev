import { z } from 'zod';
import * as queries from '../../db/queries.js';

export const checkWatcherNudgesSchema = z.object({
  // Schema-level: the field is optional with no default value. Behaviour:
  // when omitted OR set to true, the nudges are cleared after this call
  // returns. Only consume=false peeks without clearing. The description
  // spells this out so an agent inferring from the wording doesn't have
  // to guess about the absent-field semantics.
  consume: z.boolean().optional().describe('Clear the nudges after reading. Pass false to peek without clearing. When omitted, defaults to true (the nudges WILL be consumed).'),
});

/**
 * MCP tool agents can call to fetch any pending nudges from their live watcher.
 *
 * Agents should call this near the top of each turn to receive watcher
 * guidance (e.g. "you're looping on the same file, try X instead"). The
 * watcher writes nudges to a per-agent note; this tool returns them as a
 * single concatenated string and (by default) clears the note.
 */
export async function checkWatcherNudgesHandler(
  agentId: string,
  input: z.infer<typeof checkWatcherNudgesSchema>,
): Promise<string> {
  const consume = input.consume !== false;
  const key = `watcher/nudges/${agentId}`;
  const note = queries.getNote(key);
  if (!note?.value) {
    return JSON.stringify({ has_nudges: false, content: '' });
  }
  const content = note.value;
  if (consume) {
    queries.upsertNote(key, '', null);
  }
  return JSON.stringify({ has_nudges: true, content });
}
