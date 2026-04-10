import { z } from 'zod';
import { randomUUID } from 'crypto';
import * as queries from '../../db/queries.js';

export const searchKBSchema = z.object({
  query: z.string().describe('Search query for the knowledge base'),
  project_id: z.string().optional().describe('Filter by project ID'),
});

export const addKnowledgeSchema = z.object({
  title: z.string().describe('Title for the knowledge entry'),
  content: z.string().describe('Content of the knowledge entry'),
  tags: z.string().optional().describe('Comma-separated tags'),
});

export async function searchKBHandler(_agentId: string, input: z.infer<typeof searchKBSchema>): Promise<string> {
  const results = queries.searchKB(input.query, input.project_id);
  if (results.length === 0) {
    return JSON.stringify({ results: [], message: 'No knowledge base entries found matching your query.' });
  }
  return JSON.stringify({
    results: results.map(r => ({
      id: r.id,
      title: r.title,
      excerpt: r.excerpt,
      tags: r.tags,
      source: r.source,
    })),
  });
}

export async function addKnowledgeHandler(agentId: string, input: z.infer<typeof addKnowledgeSchema>): Promise<string> {
  const entry = queries.insertKBEntry({
    id: randomUUID(),
    title: input.title,
    content: input.content,
    tags: input.tags ?? null,
    agent_id: agentId,
  });
  return JSON.stringify({ success: true, id: entry.id, title: entry.title });
}
