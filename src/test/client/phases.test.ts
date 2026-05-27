import { describe, expect, it } from 'vitest';
import { formatWorkflowPhase, PHASE_LABEL } from '../../client/components/board/phases';

describe('workflow phase labels', () => {
  it('formats every workflow phase from the shared label map', () => {
    expect(PHASE_LABEL).toEqual({
      idle: 'Idle',
      assess: 'Assess',
      review: 'Review',
      implement: 'Implement',
      verify: 'Verify',
    });
    expect(formatWorkflowPhase('implement')).toBe('Implement');
  });
});
