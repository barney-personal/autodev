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
  try {
    getIo().emit('queue:snapshot', snapshot);
  } catch (err) {
    console.error('[socket] emitSnapshot error:', err);
  }
}

export function emitAgentNew(agent: AgentWithJob): void {
  const payload = { agent };
  try {
    getIo().emit('agent:new', payload);
  } catch (err) {
    console.error('[socket] emitAgentNew error:', err);
  }
  pushEvent('agent:new', payload);
}

export function emitAgentUpdate(agent: AgentWithJob): void {
  const payload = { agent };
  try {
    getIo().emit('agent:update', payload);
  } catch (err) {
    console.error('[socket] emitAgentUpdate error:', err);
  }
  pushEvent('agent:update', payload);
}

// Max payload size for agent output events (512KB). Oversized events (e.g.
// a single massive tool result) would choke Socket.io and block other events.
const MAX_OUTPUT_EVENT_BYTES = 512 * 1024;

export function emitAgentOutput(agentId: string, line: AgentOutput): void {
  try {
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
  } catch (err) {
    console.error('[socket] emitAgentOutput error:', err);
  }
}

export function emitQuestionNew(question: Question): void {
  try {
    getIo().emit('question:new', { question });
  } catch (err) {
    console.error('[socket] emitQuestionNew error:', err);
  }
}

export function emitQuestionAnswered(question: Question): void {
  try {
    getIo().emit('question:answered', { question });
  } catch (err) {
    console.error('[socket] emitQuestionAnswered error:', err);
  }
}

export function emitLockAcquired(lock: FileLock): void {
  const payload = { lock };
  try {
    getIo().emit('lock:acquired', payload);
  } catch (err) {
    console.error('[socket] emitLockAcquired error:', err);
  }
  pushEvent('lock:acquired', payload);
}

export function emitLockReleased(lockId: string, filePath: string): void {
  const payload = { lock_id: lockId, file_path: filePath };
  try {
    getIo().emit('lock:released', payload);
  } catch (err) {
    console.error('[socket] emitLockReleased error:', err);
  }
  pushEvent('lock:released', payload);
}

export function emitProjectNew(project: import('../../shared/types.js').Project): void {
  try {
    getIo().emit('project:new', { project });
  } catch (err) {
    console.error('[socket] emitProjectNew error:', err);
  }
}

export function emitJobNew(job: Job): void {
  const payload = { job };
  try {
    getIo().emit('job:new', payload);
  } catch (err) {
    console.error('[socket] emitJobNew error:', err);
  }
  pushEvent('job:new', payload);
}

export function emitJobUpdate(job: Job): void {
  const payload = { job };
  try {
    getIo().emit('job:update', payload);
  } catch (err) {
    console.error('[socket] emitJobUpdate error:', err);
  }
  pushEvent('job:update', payload);
}

export function emitPtyData(agentId: string, data: string): void {
  try {
    getIo().emit('pty:data', { agent_id: agentId, data });
  } catch (err) {
    console.error('[socket] emitPtyData error:', err);
  }
}

export function emitPtyClosed(agentId: string): void {
  try {
    getIo().emit('pty:closed', { agent_id: agentId });
  } catch (err) {
    console.error('[socket] emitPtyClosed error:', err);
  }
}

export function emitDebateNew(debate: Debate): void {
  try {
    getIo().emit('debate:new', { debate });
  } catch (err) {
    console.error('[socket] emitDebateNew error:', err);
  }
}

export function emitDebateUpdate(debate: Debate): void {
  try {
    getIo().emit('debate:update', { debate });
  } catch (err) {
    console.error('[socket] emitDebateUpdate error:', err);
  }
}

export function emitWorkflowNew(workflow: Workflow): void {
  const payload = { workflow };
  try {
    getIo().emit('workflow:new', payload);
  } catch (err) {
    console.error('[socket] emitWorkflowNew error:', err);
  }
  pushEvent('workflow:new', payload);
}

export function emitWorkflowUpdate(workflow: Workflow): void {
  const payload = { workflow };
  try {
    getIo().emit('workflow:update', payload);
  } catch (err) {
    console.error('[socket] emitWorkflowUpdate error:', err);
  }
  pushEvent('workflow:update', payload);
}

export function emitWarningNew(warning: AgentWarning): void {
  try {
    getIo().emit('warning:new', { warning });
  } catch (err) {
    console.error('[socket] emitWarningNew error:', err);
  }
}

export function emitDiscussionNew(discussion: Discussion, message: DiscussionMessage): void {
  try {
    getIo().emit('eye:discussion:new', { discussion, message });
  } catch (err) {
    console.error('[socket] emitDiscussionNew error:', err);
  }
}

export function emitDiscussionMessage(message: DiscussionMessage): void {
  try {
    getIo().emit('eye:discussion:message', { message });
  } catch (err) {
    console.error('[socket] emitDiscussionMessage error:', err);
  }
}

export function emitDiscussionUpdate(discussion: Discussion): void {
  try {
    getIo().emit('eye:discussion:update', { discussion });
  } catch (err) {
    console.error('[socket] emitDiscussionUpdate error:', err);
  }
}

export function emitProposalNew(proposal: Proposal): void {
  try {
    getIo().emit('eye:proposal:new', { proposal });
  } catch (err) {
    console.error('[socket] emitProposalNew error:', err);
  }
}

export function emitProposalUpdate(proposal: Proposal): void {
  try {
    getIo().emit('eye:proposal:update', { proposal });
  } catch (err) {
    console.error('[socket] emitProposalUpdate error:', err);
  }
}

export function emitProposalMessage(message: ProposalMessage): void {
  try {
    getIo().emit('eye:proposal:message', { message });
  } catch (err) {
    console.error('[socket] emitProposalMessage error:', err);
  }
}

export function emitPrNew(pr: Pr): void {
  try {
    getIo().emit('eye:pr:new', { pr });
  } catch (err) {
    console.error('[socket] emitPrNew error:', err);
  }
}

export function emitPrReviewNew(review: PrReview): void {
  try {
    getIo().emit('eye:pr-review:new', { review });
  } catch (err) {
    console.error('[socket] emitPrReviewNew error:', err);
  }
}

export function emitPrReviewUpdate(review: PrReview): void {
  try {
    getIo().emit('eye:pr-review:update', { review });
  } catch (err) {
    console.error('[socket] emitPrReviewUpdate error:', err);
  }
}

export function emitPrReviewMessage(message: PrReviewMessage): void {
  try {
    getIo().emit('eye:pr-review:message', { message });
  } catch (err) {
    console.error('[socket] emitPrReviewMessage error:', err);
  }
}
