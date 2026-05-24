import type { CreateWorkflowRequest, StopMode } from './types.js';

export const WORKFLOW_UNBOUNDED_MAX_TURNS = 10_000;
export const WORKFLOW_DEFAULT_STOP_MODE: StopMode = 'completion';
export const WORKFLOW_DEFAULT_STOP_VALUE: number | null = null;

type WorkflowRunCapInput = Pick<CreateWorkflowRequest,
  | 'maxTurnsAssess'
  | 'maxTurnsReview'
  | 'maxTurnsImplement'
  | 'stopModeAssess'
  | 'stopModeReview'
  | 'stopModeImplement'
  | 'stopValueAssess'
  | 'stopValueReview'
  | 'stopValueImplement'
>;

export interface WorkflowRunCapIssue {
  field: keyof WorkflowRunCapInput;
  message: string;
}

const WORKFLOW_PHASE_CAP_FIELDS = [
  {
    maxTurns: 'maxTurnsAssess',
    stopMode: 'stopModeAssess',
    stopValue: 'stopValueAssess',
  },
  {
    maxTurns: 'maxTurnsReview',
    stopMode: 'stopModeReview',
    stopValue: 'stopValueReview',
  },
  {
    maxTurns: 'maxTurnsImplement',
    stopMode: 'stopModeImplement',
    stopValue: 'stopValueImplement',
  },
] as const satisfies ReadonlyArray<{
  maxTurns: keyof WorkflowRunCapInput;
  stopMode: keyof WorkflowRunCapInput;
  stopValue: keyof WorkflowRunCapInput;
}>;

export function getWorkflowRunCapIssues(input: Partial<WorkflowRunCapInput>): WorkflowRunCapIssue[] {
  const issues: WorkflowRunCapIssue[] = [];
  for (const fields of WORKFLOW_PHASE_CAP_FIELDS) {
    if (input[fields.maxTurns] !== undefined) {
      issues.push({
        field: fields.maxTurns,
        message: `${fields.maxTurns} is disabled for autonomous workflows; workflow phases run to completion instead of a turn cap`,
      });
    }

    const stopMode = input[fields.stopMode] as StopMode | undefined;
    if (stopMode !== undefined && stopMode !== WORKFLOW_DEFAULT_STOP_MODE) {
      issues.push({
        field: fields.stopMode,
        message: `${fields.stopMode}=${String(stopMode)} is disabled for autonomous workflows; use completion/no cap`,
      });
    }

    if (input[fields.stopValue] !== undefined) {
      issues.push({
        field: fields.stopValue,
        message: `${fields.stopValue} is disabled for autonomous workflows; workflow phases run to completion instead of a budget/time/turn cap`,
      });
    }
  }
  return issues;
}

export function firstWorkflowRunCapIssue(input: Partial<WorkflowRunCapInput>): string | null {
  return getWorkflowRunCapIssues(input)[0]?.message ?? null;
}
