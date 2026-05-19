import { useEffect, useRef } from 'react';
import socket from '../socket';
import type { AgentWithJob, AgentWarning, Job, Project, Question, FileLock, AgentOutput, QueueSnapshot, Debate, Workflow, Discussion, Proposal, JobWatcher, WatcherCommentary, WatcherAction, ResolverRun, ServerToClientEvents } from '@shared/types';

interface SocketHandlers {
  onSnapshot: (snapshot: QueueSnapshot) => void;
  onAgentNew: (agent: AgentWithJob) => void;
  onAgentUpdate: (agent: AgentWithJob) => void;
  onAgentOutput: (agentId: string, line: AgentOutput) => void;
  onQuestionNew: (question: Question) => void;
  onQuestionAnswered: (question: Question) => void;
  onLockAcquired: (lock: FileLock) => void;
  onLockReleased: (lockId: string, filePath: string) => void;
  onJobNew: (job: Job) => void;
  onJobUpdate: (job: Job) => void;
  onProjectNew?: (project: Project) => void;
  onDebateNew?: (debate: Debate) => void;
  onDebateUpdate?: (debate: Debate) => void;
  onWorkflowNew?: (workflow: Workflow) => void;
  onWorkflowUpdate?: (workflow: Workflow) => void;
  onWarningNew?: (payload: { warning: AgentWarning }) => void;
  onDiscussionNew?: (discussion: Discussion) => void;
  onDiscussionUpdate?: (discussion: Discussion) => void;
  onProposalNew?: (proposal: Proposal) => void;
  onProposalUpdate?: (proposal: Proposal) => void;
  onWatcherSessionNew?: (watcher: JobWatcher) => void;
  onWatcherSessionUpdate?: (watcher: JobWatcher) => void;
  onWatcherCommentaryNew?: (commentary: WatcherCommentary) => void;
  onWatcherActionNew?: (action: WatcherAction) => void;
  onResolverRunNew?: (run: ResolverRun) => void;
  onResolverRunUpdate?: (run: ResolverRun) => void;
}

export function useSocket(handlers: SocketHandlers): void {
  // Store handlers in a ref so the socket listeners always call the latest version.
  const ref = useRef(handlers);
  ref.current = handlers;

  useEffect(() => {
    // socket.io's generic on/off signatures use conditional types that don't resolve
    // when the event name is a forwarded generic — cast to our expected shape.
    type OnOff = <E extends keyof ServerToClientEvents>(ev: E, fn: ServerToClientEvents[E]) => void;
    const h = <E extends keyof ServerToClientEvents>(ev: E, fn: ServerToClientEvents[E]) => {
      (socket.on as OnOff)(ev, fn);
      return () => { (socket.off as OnOff)(ev, fn); };
    };

    const offs = [
      h('queue:snapshot', (snapshot: QueueSnapshot) => ref.current.onSnapshot(snapshot)),
      h('agent:new', ({ agent }: { agent: AgentWithJob }) => ref.current.onAgentNew(agent)),
      h('agent:update', ({ agent }: { agent: AgentWithJob }) => ref.current.onAgentUpdate(agent)),
      h('agent:output', ({ agent_id, line }: { agent_id: string; line: AgentOutput }) => ref.current.onAgentOutput(agent_id, line)),
      h('question:new', ({ question }: { question: Question }) => ref.current.onQuestionNew(question)),
      h('question:answered', ({ question }: { question: Question }) => ref.current.onQuestionAnswered(question)),
      h('lock:acquired', ({ lock }: { lock: FileLock }) => ref.current.onLockAcquired(lock)),
      h('lock:released', ({ lock_id, file_path }: { lock_id: string; file_path: string }) => ref.current.onLockReleased(lock_id, file_path)),
      h('job:new', ({ job }: { job: Job }) => ref.current.onJobNew(job)),
      h('job:update', ({ job }: { job: Job }) => ref.current.onJobUpdate(job)),
      h('project:new', ({ project }: { project: Project }) => ref.current.onProjectNew?.(project)),
      h('debate:new', ({ debate }: { debate: Debate }) => ref.current.onDebateNew?.(debate)),
      h('debate:update', ({ debate }: { debate: Debate }) => ref.current.onDebateUpdate?.(debate)),
      h('workflow:new', ({ workflow }: { workflow: Workflow }) => ref.current.onWorkflowNew?.(workflow)),
      h('workflow:update', ({ workflow }: { workflow: Workflow }) => ref.current.onWorkflowUpdate?.(workflow)),
      h('warning:new', (payload: { warning: AgentWarning }) => ref.current.onWarningNew?.(payload)),
      h('eye:discussion:new', ({ discussion }) => ref.current.onDiscussionNew?.(discussion)),
      h('eye:discussion:update', ({ discussion }) => ref.current.onDiscussionUpdate?.(discussion)),
      h('eye:proposal:new', ({ proposal }) => ref.current.onProposalNew?.(proposal)),
      h('eye:proposal:update', ({ proposal }) => ref.current.onProposalUpdate?.(proposal)),
      h('watcher:session:new', ({ watcher }) => ref.current.onWatcherSessionNew?.(watcher)),
      h('watcher:session:update', ({ watcher }) => ref.current.onWatcherSessionUpdate?.(watcher)),
      h('watcher:commentary:new', ({ commentary }) => ref.current.onWatcherCommentaryNew?.(commentary)),
      h('watcher:action:new', ({ action }) => ref.current.onWatcherActionNew?.(action)),
      h('resolver:run:new', ({ run }) => ref.current.onResolverRunNew?.(run)),
      h('resolver:run:update', ({ run }) => ref.current.onResolverRunUpdate?.(run)),
    ];

    // The server already pushes a snapshot on every new connection (io.on('connection')),
    // so we do NOT request one on the 'connect' event — that would cause a duplicate
    // snapshot that races with individual events and overwrites newer state with stale data.
    //
    // The only case we need to manually request is if the socket was already connected
    // before this effect ran (React StrictMode double-mount, Vite HMR), because the
    // server's connection handler already fired and won't fire again.
    if (socket.connected) {
      socket.emit('request:snapshot');
    }

    return () => {
      for (const off of offs) off();
    };
  }, []);
}
