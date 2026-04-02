import { z } from 'zod';
import * as socket from '../../socket/SocketManager.js';
import { createAutonomousAgentRun } from '../../orchestrator/AutonomousAgentRunManager.js';

export const createAutonomousAgentRunSchema = z.object({
  task: z.string().describe('High-level task for the autonomous agent run'),
  title: z.string().optional().describe('Optional title for the autonomous agent run'),
  workDir: z.string().optional().describe('Repo or working directory for the run'),
  implementerModel: z.string().optional().describe('Implementer model override'),
  reviewerModel: z.string().optional().describe('Reviewer model override'),
  maxCycles: z.number().optional().describe('Maximum assess/review/implement cycles, clamped to 1-50'),
  maxTurnsAssess: z.number().optional().describe('Legacy assess turn limit when using turn-based stopping'),
  maxTurnsReview: z.number().optional().describe('Legacy review turn limit when using turn-based stopping'),
  maxTurnsImplement: z.number().optional().describe('Legacy implement turn limit when using turn-based stopping'),
  stopModeAssess: z.enum(['turns', 'budget', 'time', 'completion']).optional().describe('Assess phase stopping mode'),
  stopValueAssess: z.number().optional().describe('Assess stopping value'),
  stopModeReview: z.enum(['turns', 'budget', 'time', 'completion']).optional().describe('Review phase stopping mode'),
  stopValueReview: z.number().optional().describe('Review stopping value'),
  stopModeImplement: z.enum(['turns', 'budget', 'time', 'completion']).optional().describe('Implement phase stopping mode'),
  stopValueImplement: z.number().optional().describe('Implement stopping value'),
  templateId: z.string().optional().describe('Optional template to apply'),
  useWorktree: z.boolean().optional().describe('Whether to create a shared git worktree for the run'),
});

export async function createAutonomousAgentRunHandler(
  _agentId: string,
  input: z.infer<typeof createAutonomousAgentRunSchema>,
): Promise<string> {
  const result = createAutonomousAgentRun(input);
  socket.emitWorkflowNew(result.workflow);
  return JSON.stringify({
    autonomous_agent_run_id: result.workflow.id,
    title: result.workflow.title,
    status: result.workflow.status,
    project_id: result.project.id,
    assess_job_id: result.jobs[0]?.id ?? null,
  });
}
