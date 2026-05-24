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
  maxTurnsAssess: z.number().optional().describe('Disabled for autonomous workflows; phases run to completion'),
  maxTurnsReview: z.number().optional().describe('Disabled for autonomous workflows; phases run to completion'),
  maxTurnsImplement: z.number().optional().describe('Disabled for autonomous workflows; phases run to completion'),
  stopModeAssess: z.enum(['turns', 'budget', 'time', 'completion']).optional().describe('Only completion/no cap is accepted for autonomous workflows'),
  stopValueAssess: z.number().optional().describe('Disabled for autonomous workflows; phases run to completion'),
  stopModeReview: z.enum(['turns', 'budget', 'time', 'completion']).optional().describe('Only completion/no cap is accepted for autonomous workflows'),
  stopValueReview: z.number().optional().describe('Disabled for autonomous workflows; phases run to completion'),
  stopModeImplement: z.enum(['turns', 'budget', 'time', 'completion']).optional().describe('Only completion/no cap is accepted for autonomous workflows'),
  stopValueImplement: z.number().optional().describe('Disabled for autonomous workflows; phases run to completion'),
  templateId: z.string().optional().describe('Optional template to apply'),
  useWorktree: z.boolean().optional().describe('Whether to create a shared git worktree for the run'),
  completionThreshold: z.number().optional().describe('Fraction of milestones (0.1-1.0) required to consider the workflow complete. Default 1.0 (all milestones). When threshold < 1.0 and met, creates a full (non-draft) PR.'),
  startCommand: z.string().optional().describe('Command to start the app for smoke testing before PR creation. e.g. npm run dev, docker compose up. NULL = skip verify.'),
  maxVerifyRetries: z.number().optional().describe('Max verify retries before blocking (default 2). Only used when startCommand is set.'),
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
