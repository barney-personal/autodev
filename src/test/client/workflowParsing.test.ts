import { describe, it, expect } from 'vitest';
import {
  parsePlanMilestones,
  parseWorklog,
  extractSection,
  extractBullets,
  shortenMilestoneTitle,
} from '../../client/utils/workflowParsing';

describe('parsePlanMilestones', () => {
  it('returns empty array for null', () => {
    expect(parsePlanMilestones(null)).toEqual([]);
  });

  it('returns empty array for empty string', () => {
    expect(parsePlanMilestones('')).toEqual([]);
  });

  it('returns empty array when plan has no checkbox bullets', () => {
    expect(parsePlanMilestones('# Plan\n\nSome text without bullets.')).toEqual([]);
  });

  it('parses mixed checked and unchecked bullets', () => {
    const plan = `# Plan
- [x] First milestone done
- [ ] Second milestone pending
- [X] Third uppercase X done
* [ ] Fourth using asterisk
`;
    const out = parsePlanMilestones(plan);
    expect(out).toHaveLength(4);
    expect(out[0].title).toBe('First milestone done');
    expect(out[1].title).toBe('Second milestone pending');
    expect(out[2].title).toBe('Third uppercase X done');
    expect(out[3].title).toBe('Fourth using asterisk');
  });

  it('parses all-checked plan', () => {
    const plan = `- [x] A\n- [x] B\n- [x] C`;
    const out = parsePlanMilestones(plan);
    expect(out.map(m => m.title)).toEqual(['A', 'B', 'C']);
  });

  it('shortens long bold milestone titles at em-dash boundary', () => {
    const plan = `- [ ] **M6: ControlRoom decomposition** [M] — extract parsing utilities to a shared module and split sub-components into individual files`;
    const out = parsePlanMilestones(plan);
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe('M6: ControlRoom decomposition [M]');
    expect(out[0].full).toContain('extract parsing utilities');
  });

  it('strips wrapping backticks', () => {
    const plan = `- [ ] \`refactor foo\``;
    const out = parsePlanMilestones(plan);
    expect(out[0].title).toBe('refactor foo');
  });

  it('ignores indented sub-bullets that are not checkbox lines', () => {
    const plan = `- [ ] Top-level
  - nested bullet (not a checkbox)
- [x] Second top-level`;
    const out = parsePlanMilestones(plan);
    expect(out.map(m => m.title)).toEqual(['Top-level', 'Second top-level']);
  });
});

describe('shortenMilestoneTitle', () => {
  it('truncates very long titles at sentence boundary when possible', () => {
    const long = 'A'.repeat(50) + '. ' + 'B'.repeat(200);
    const { title } = shortenMilestoneTitle(long);
    expect(title.length).toBeLessThanOrEqual(140);
    expect(title.endsWith('.')).toBe(true);
  });

  it('falls back to ellipsis truncation for titles with no sentence boundary', () => {
    const long = 'X'.repeat(200);
    const { title } = shortenMilestoneTitle(long);
    expect(title.length).toBeLessThanOrEqual(140);
    expect(title.endsWith('…')).toBe(true);
  });
});

describe('extractSection', () => {
  it('returns null when heading is missing', () => {
    expect(extractSection('## Cycle 1\nbody', '### Missing')).toBeNull();
  });

  it('captures content between heading and next ## or ### heading', () => {
    const text = `### Commits\n- a\n- b\n\n### Test results\n- ok`;
    expect(extractSection(text, '### Commits')).toBe('- a\n- b');
  });

  it('captures content to end when no following heading', () => {
    const text = `### Next step\nDo the thing`;
    expect(extractSection(text, '### Next step')).toBe('Do the thing');
  });
});

describe('extractBullets', () => {
  it('returns empty list when section missing', () => {
    expect(extractBullets('no section', '### Commits')).toEqual([]);
  });

  it('extracts trimmed bullets only', () => {
    const text = `### Commits\n- abc123 first\n- def456 second\nfree text\n\n### Other`;
    expect(extractBullets(text, '### Commits')).toEqual(['abc123 first', 'def456 second']);
  });
});

describe('parseWorklog', () => {
  it('parses cycle number, milestone, commits, tests, blockers, next step, and preserves updatedAt', () => {
    const value = `## Cycle 4 — M4: TaskForm extraction
**Owner:** Implementer

### What changed
- some change

### Commits
- 9547107 Extract useTaskFormState
- abc123 Follow-up commit

### Test results
- 2 files, 25 tests passed

### Blockers
- None

### Next step
Proceed to M5.`;
    const parsed = parseWorklog({ value, updated_at: 1234567 });
    expect(parsed.cycle).toBe(4);
    expect(parsed.milestone).toBe('M4: TaskForm extraction');
    expect(parsed.commits).toEqual(['9547107 Extract useTaskFormState', 'abc123 Follow-up commit']);
    expect(parsed.tests).toEqual(['2 files, 25 tests passed']);
    expect(parsed.blockers).toEqual(['None']);
    expect(parsed.nextStep).toBe('Proceed to M5.');
    expect(parsed.updatedAt).toBe(1234567);
  });

  it('returns null cycle/milestone when not parseable', () => {
    const parsed = parseWorklog({ value: 'just some text', updated_at: 0 });
    expect(parsed.cycle).toBeNull();
    expect(parsed.milestone).toBeNull();
    expect(parsed.commits).toEqual([]);
    expect(parsed.tests).toEqual([]);
    expect(parsed.blockers).toEqual([]);
    expect(parsed.nextStep).toBeNull();
    expect(parsed.updatedAt).toBe(0);
  });

  it('handles a worklog with cycle but no milestone title', () => {
    const value = `## Cycle 2\nbody`;
    const parsed = parseWorklog({ value, updated_at: 1 });
    expect(parsed.cycle).toBe(2);
    expect(parsed.milestone).toBeNull();
  });

  it('parses cycle title with en-dash and hyphen variants', () => {
    expect(parseWorklog({ value: '## Cycle 1 – Hyphen variant', updated_at: 0 }).milestone).toBe('Hyphen variant');
    expect(parseWorklog({ value: '## Cycle 1 - Plain dash', updated_at: 0 }).milestone).toBe('Plain dash');
  });
});
