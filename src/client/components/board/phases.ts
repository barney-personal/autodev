import type { WorkflowPhase } from '@shared/types';

export const PHASE_LABEL: Record<WorkflowPhase, string> = {
  idle: 'Idle',
  assess: 'Assess',
  review: 'Review',
  implement: 'Implement',
  verify: 'Verify',
};

export function formatWorkflowPhase(phase: WorkflowPhase): string {
  return PHASE_LABEL[phase] ?? phase;
}
