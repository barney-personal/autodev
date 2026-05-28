export interface ParsedMilestone {
  title: string;
  full: string;
}

export interface ParsedWorklog {
  cycle: number | null;
  milestone: string | null;
  commits: string[];
  tests: string[];
  blockers: string[];
  nextStep: string | null;
  /** Original `updated_at` from the raw worklog row, preserved so activity entries don't all collapse to `Date.now()`. */
  updatedAt: number;
}

export function shortenMilestoneTitle(raw: string): { title: string; full: string } {
  const stripped = raw
    .replace(/^\*\*/, '')
    .replace(/\*\*$/, '')
    .replace(/^`+|`+$/g, '')
    .trim();
  const dashSplit = stripped.split(/\s+[—–-]\s+/);
  const head = dashSplit[0] && dashSplit[0].length < 140 ? dashSplit[0] : stripped;
  let title = head;
  if (title.length > 140) {
    const sentenceMatch = title.match(/^(.{0,140}[.!?])(\s|$)/);
    if (sentenceMatch) title = sentenceMatch[1];
    else title = title.slice(0, 137) + '…';
  }
  title = title.replace(/\*\*/g, '').trim();
  return { title, full: stripped };
}

export function parsePlanMilestones(plan: string | null): ParsedMilestone[] {
  if (!plan) return [];
  const lines = plan.split('\n');
  const out: ParsedMilestone[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    const m = line.match(/^[-*]\s*\[([ xX])\]\s+(.+)$/);
    if (m) {
      const { title, full } = shortenMilestoneTitle(m[2]);
      if (title) out.push({ title, full });
    }
  }
  return out;
}

export function extractSection(text: string, heading: string): string | null {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = text.match(new RegExp(`${escaped}\\n([\\s\\S]*?)(?:\\n### |\\n## |$)`));
  return match?.[1]?.trim() || null;
}

export function extractBullets(text: string, heading: string): string[] {
  const section = extractSection(text, heading);
  if (!section) return [];
  return section
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.startsWith('- '))
    .map(l => l.slice(2).trim());
}

export function parseWorklog(entry: { value: string; updated_at: number }): ParsedWorklog {
  const value = entry.value;
  const cycleMatch = value.match(/##\s+Cycle\s+(\d+)/);
  const titleMatch = value.match(/^##\s+Cycle\s+\d+\s+[—–-]\s+(.+)$/m);
  return {
    cycle: cycleMatch ? Number(cycleMatch[1]) : null,
    milestone: titleMatch?.[1]?.trim() ?? null,
    commits: extractBullets(value, '### Commits'),
    tests: extractBullets(value, '### Test results'),
    blockers: extractBullets(value, '### Blockers'),
    nextStep: extractSection(value, '### Next step'),
    updatedAt: entry.updated_at,
  };
}
