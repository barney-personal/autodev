import { Server as HttpServer } from 'http';
import { Server as SocketIoServer } from 'socket.io';
import type { ServerToClientEvents, ClientToServerEvents, AgentWithJob, Job, Question, FileLock, AgentOutput, QueueSnapshot, Debate, AgentWarning, Discussion, DiscussionMessage, Proposal, ProposalMessage, Workflow, Pr, PrReview, PrReviewMessage } from '../../shared/types.js';

let _io: SocketIoServer<ClientToServerEvents, ServerToClientEvents> | null = null;

export function initSocketManager(httpServer: HttpServer): SocketIoServer<ClientToServerEvents, ServerToClientEvents> {
  const io = new SocketIoServer<ClientToServerEvents, ServerToClientEvents>(httpServer, {
    cors: { origin: '*' },
  });

  io.on('connection', (socket) => {
    console.log(`[socket] client connected: ${socket.id}`);
    socket.on('disconnect', () => {
      console.log(`[socket] client disconnected: ${socket.id}`);
    });
  });

  _io = io;
  return io;
}

export function getIo(): SocketIoServer<ClientToServerEvents, ServerToClientEvents> {
  if (!_io) throw new Error('SocketManager not initialized');
  return _io;
}

export function emitSnapshot(snapshot: QueueSnapshot): void {
  getIo().emit('queue:snapshot', snapshot);
}

export function emitAgentNew(agent: AgentWithJob): void {
  getIo().emit('agent:new', { agent });
}

export function emitAgentUpdate(agent: AgentWithJob): void {
  getIo().emit('agent:update', { agent });
}

export function emitAgentOutput(agentId: string, line: AgentOutput): void {
  getIo().emit('agent:output', { agent_id: agentId, line });
}

export function emitQuestionNew(question: Question): void {
  getIo().emit('question:new', { question });
}

export function emitQuestionAnswered(question: Question): void {
  getIo().emit('question:answered', { question });
}

export function emitLockAcquired(lock: FileLock): void {
  getIo().emit('lock:acquired', { lock });
}

export function emitLockReleased(lockId: string, filePath: string): void {
  getIo().emit('lock:released', { lock_id: lockId, file_path: filePath });
}

export function emitProjectNew(project: import('../../shared/types.js').Project): void {
  getIo().emit('project:new', { project });
}

export function emitJobNew(job: Job): void {
  getIo().emit('job:new', { job });
}

export function emitJobUpdate(job: Job): void {
  getIo().emit('job:update', { job });
}

export function emitPtyData(agentId: string, data: string): void {
  getIo().emit('pty:data', { agent_id: agentId, data });
}

export function emitPtyClosed(agentId: string): void {
  getIo().emit('pty:closed', { agent_id: agentId });
}

export function emitDebateNew(debate: Debate): void {
  getIo().emit('debate:new', { debate });
}

export function emitDebateUpdate(debate: Debate): void {
  getIo().emit('debate:update', { debate });
}

export function emitWorkflowNew(workflow: Workflow): void {
  getIo().emit('workflow:new', { workflow });
}

export function emitWorkflowUpdate(workflow: Workflow): void {
  getIo().emit('workflow:update', { workflow });
}

export function emitWarningNew(warning: AgentWarning): void {
  getIo().emit('warning:new', { warning });
}

export function emitDiscussionNew(discussion: Discussion, message: DiscussionMessage): void { getIo().emit('eye:discussion:new', { discussion, message }); }
export function emitDiscussionMessage(message: DiscussionMessage): void { getIo().emit('eye:discussion:message', { message }); }
export function emitDiscussionUpdate(discussion: Discussion): void { getIo().emit('eye:discussion:update', { discussion }); }
export function emitProposalNew(proposal: Proposal): void { getIo().emit('eye:proposal:new', { proposal }); }
export function emitProposalUpdate(proposal: Proposal): void { getIo().emit('eye:proposal:update', { proposal }); }
export function emitProposalMessage(message: ProposalMessage): void { getIo().emit('eye:proposal:message', { message }); }
export function emitPrNew(pr: Pr): void { getIo().emit('eye:pr:new', { pr }); }
export function emitPrReviewNew(review: PrReview): void { getIo().emit('eye:pr-review:new', { review }); }
export function emitPrReviewUpdate(review: PrReview): void { getIo().emit('eye:pr-review:update', { review }); }
export function emitPrReviewMessage(message: PrReviewMessage): void { getIo().emit('eye:pr-review:message', { message }); }
