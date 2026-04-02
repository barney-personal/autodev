import { Server as HttpServer } from 'http';
import { Server as SocketIoServer } from 'socket.io';
import type { ServerToClientEvents, ClientToServerEvents, AgentWithJob, Job, Question, FileLock, AgentOutput, QueueSnapshot, Debate, AgentWarning, Discussion, DiscussionMessage, Proposal, ProposalMessage, Workflow, Pr, PrReview, PrReviewMessage } from '../../shared/types.js';
import { pushEvent } from '../orchestrator/EventQueue.js';

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
  const payload = { agent };
  getIo().emit('agent:new', payload);
  pushEvent('agent:new', payload);
}

export function emitAgentUpdate(agent: AgentWithJob): void {
  const payload = { agent };
  getIo().emit('agent:update', payload);
  pushEvent('agent:update', payload);
}

// Max payload size for agent output events (512KB). Oversized events (e.g.
// a single massive tool result) would choke Socket.io and block other events.
const MAX_OUTPUT_EVENT_BYTES = 512 * 1024;

export function emitAgentOutput(agentId: string, line: AgentOutput): void {
  // Guard against oversized output events that would block Socket.io
  if (line.content && line.content.length > MAX_OUTPUT_EVENT_BYTES) {
    const truncated = {
      ...line,
      content: line.content.slice(0, MAX_OUTPUT_EVENT_BYTES) + '\n[TRUNCATED: output exceeded 512KB limit]',
    };
    getIo().emit('agent:output', { agent_id: agentId, line: truncated });
    return;
  }
  getIo().emit('agent:output', { agent_id: agentId, line });
}

export function emitQuestionNew(question: Question): void {
  getIo().emit('question:new', { question });
}

export function emitQuestionAnswered(question: Question): void {
  getIo().emit('question:answered', { question });
}

export function emitLockAcquired(lock: FileLock): void {
  const payload = { lock };
  getIo().emit('lock:acquired', payload);
  pushEvent('lock:acquired', payload);
}

export function emitLockReleased(lockId: string, filePath: string): void {
  const payload = { lock_id: lockId, file_path: filePath };
  getIo().emit('lock:released', payload);
  pushEvent('lock:released', payload);
}

export function emitProjectNew(project: import('../../shared/types.js').Project): void {
  getIo().emit('project:new', { project });
}

export function emitJobNew(job: Job): void {
  const payload = { job };
  getIo().emit('job:new', payload);
  pushEvent('job:new', payload);
}

export function emitJobUpdate(job: Job): void {
  const payload = { job };
  getIo().emit('job:update', payload);
  pushEvent('job:update', payload);
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
  const payload = { workflow };
  getIo().emit('workflow:new', payload);
  pushEvent('workflow:new', payload);
}

export function emitWorkflowUpdate(workflow: Workflow): void {
  const payload = { workflow };
  getIo().emit('workflow:update', payload);
  pushEvent('workflow:update', payload);
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
