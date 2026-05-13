import { create } from 'zustand';
import type {
  AgentWithJob,
  Job,
  FileLock,
  Template,
  Project,
  Debate,
  Workflow,
  Discussion,
  Proposal,
  CreateDebateRequest,
  JobWatcher,
  WatcherCommentary,
  WatcherAction,
} from '@shared/types';

// ── UI state ────────────────────────────────────────────────────────────────
export interface UIState {
  // Selection
  selectedAgent: AgentWithJob | null;
  selectedDebate: Debate | null;
  selectedWorkflow: Workflow | null;
  activeProjectId: string | null;

  // Modal visibility
  showTaskForm: boolean;
  showTemplates: boolean;
  showBatchTemplates: boolean;
  showUsage: boolean;
  showSearch: boolean;
  showProjects: boolean;
  showSettings: boolean;
  showDebateForm: boolean;
  showKnowledgeBase: boolean;
  showEye: boolean;

  // Debate form initial data
  debateFormInitial: Partial<CreateDebateRequest> | undefined;

  // Cost tracking
  todayClaudeCost: number | null;
  todayCodexCost: number | null;
  costAutoUpdate: boolean;

  // Eye
  eyeEnabled: boolean;

  // Dashboard clock (for live workflow timers)
  dashboardNow: number;

  // PTY idle detection
  ptyIdleAgents: Set<string>;
}

export interface UIActions {
  setSelectedAgent: (agent: AgentWithJob | null) => void;
  setSelectedDebate: (debate: Debate | null) => void;
  setSelectedWorkflow: (workflow: Workflow | null) => void;
  setActiveProjectId: (id: string | null) => void;

  setShowTaskForm: (show: boolean) => void;
  setShowTemplates: (show: boolean) => void;
  setShowBatchTemplates: (show: boolean) => void;
  setShowUsage: (show: boolean) => void;
  setShowSearch: (show: boolean) => void;
  setShowProjects: (show: boolean) => void;
  setShowSettings: (show: boolean) => void;
  setShowDebateForm: (show: boolean) => void;
  setShowKnowledgeBase: (show: boolean) => void;
  setShowEye: (show: boolean | ((prev: boolean) => boolean)) => void;

  setDebateFormInitial: (initial: Partial<CreateDebateRequest> | undefined) => void;

  setTodayClaudeCost: (cost: number | null) => void;
  setTodayCodexCost: (cost: number | null) => void;
  setCostAutoUpdate: (enabled: boolean | ((prev: boolean) => boolean)) => void;

  setEyeEnabled: (enabled: boolean) => void;
  setDashboardNow: (now: number) => void;
  setPtyIdleAgents: (agents: Set<string> | ((prev: Set<string>) => Set<string>)) => void;

  resetToHome: () => void;
  closeTerminal: () => void;
}

// ── Data state ──────────────────────────────────────────────────────────────
export interface DataState {
  agents: AgentWithJob[];
  jobs: Job[];
  locks: FileLock[];
  templates: Template[];
  projects: Project[];
  debates: Debate[];
  workflows: Workflow[];
  discussions: Discussion[];
  proposals: Proposal[];

  // Live watcher
  watchersByAgent: Record<string, JobWatcher>;
  commentaryByAgent: Record<string, WatcherCommentary[]>;
  actionsByAgent: Record<string, WatcherAction[]>;

  archivedJobs: Job[];
  archivedAgents: AgentWithJob[];
  archivedTotal: number;
  archivedLoading: boolean;
}

export interface DataActions {
  setAgents: (agents: AgentWithJob[]) => void;
  addAgent: (agent: AgentWithJob) => void;
  updateAgent: (agent: AgentWithJob) => void;

  setJobs: (jobs: Job[]) => void;
  addJob: (job: Job) => void;
  updateJob: (job: Job) => void;

  setLocks: (locks: FileLock[]) => void;
  addLock: (lock: FileLock) => void;
  removeLock: (lockId: string) => void;
  purgeExpiredLocks: () => void;

  setTemplates: (templates: Template[]) => void;

  setProjects: (projects: Project[]) => void;
  addProject: (project: Project) => void;
  updateProject: (project: Project) => void;
  removeProject: (id: string) => void;

  setDebates: (debates: Debate[]) => void;
  addDebate: (debate: Debate) => void;
  updateDebate: (debate: Debate) => void;

  setWorkflows: (workflows: Workflow[]) => void;
  addWorkflow: (workflow: Workflow) => void;
  updateWorkflow: (workflow: Workflow) => void;

  setDiscussions: (discussions: Discussion[]) => void;
  addOrUpdateDiscussion: (discussion: Discussion) => void;
  setProposals: (proposals: Proposal[]) => void;
  addOrUpdateProposal: (proposal: Proposal) => void;

  setArchivedJobs: (jobs: Job[]) => void;
  appendArchivedJobs: (jobs: Job[]) => void;
  setArchivedAgents: (agents: AgentWithJob[]) => void;
  appendArchivedAgents: (agents: AgentWithJob[]) => void;
  setArchivedTotal: (total: number) => void;
  setArchivedLoading: (loading: boolean) => void;

  // Live watcher
  upsertWatcher: (watcher: JobWatcher) => void;
  appendWatcherCommentary: (commentary: WatcherCommentary) => void;
  setWatcherCommentary: (agentId: string, commentary: WatcherCommentary[]) => void;
  appendWatcherAction: (action: WatcherAction) => void;
  setWatcherActions: (agentId: string, actions: WatcherAction[]) => void;
}

export type AppStore = UIState & UIActions & DataState & DataActions;

export const useAppStore = create<AppStore>()((set) => ({
  // ── UI defaults ───────────────────────────────────────────────────────────
  selectedAgent: null,
  selectedDebate: null,
  selectedWorkflow: null,
  activeProjectId: null,

  showTaskForm: false,
  showTemplates: false,
  showBatchTemplates: false,
  showUsage: false,
  showSearch: false,
  showProjects: false,
  showSettings: false,
  showDebateForm: false,
  showKnowledgeBase: false,
  showEye: false,

  debateFormInitial: undefined,

  todayClaudeCost: null,
  todayCodexCost: null,
  costAutoUpdate: false,

  eyeEnabled: false,
  dashboardNow: Date.now(),
  ptyIdleAgents: new Set(),

  // ── UI actions ────────────────────────────────────────────────────────────
  setSelectedAgent: (agent) => set({ selectedAgent: agent }),
  setSelectedDebate: (debate) => set({ selectedDebate: debate }),
  setSelectedWorkflow: (workflow) => set({ selectedWorkflow: workflow }),
  setActiveProjectId: (id) => set({ activeProjectId: id }),

  setShowTaskForm: (show) => set({ showTaskForm: show }),
  setShowTemplates: (show) => set({ showTemplates: show }),
  setShowBatchTemplates: (show) => set({ showBatchTemplates: show }),
  setShowUsage: (show) => set({ showUsage: show }),
  setShowSearch: (show) => set({ showSearch: show }),
  setShowProjects: (show) => set({ showProjects: show }),
  setShowSettings: (show) => set({ showSettings: show }),
  setShowDebateForm: (show) => set({ showDebateForm: show }),
  setShowKnowledgeBase: (show) => set({ showKnowledgeBase: show }),
  setShowEye: (show) => set(state => ({
    showEye: typeof show === 'function' ? show(state.showEye) : show,
  })),

  setDebateFormInitial: (initial) => set({ debateFormInitial: initial }),
  setTodayClaudeCost: (cost) => set({ todayClaudeCost: cost }),
  setTodayCodexCost: (cost) => set({ todayCodexCost: cost }),
  setCostAutoUpdate: (enabled) => set(state => ({
    costAutoUpdate: typeof enabled === 'function' ? enabled(state.costAutoUpdate) : enabled,
  })),
  setEyeEnabled: (enabled) => set({ eyeEnabled: enabled }),
  setDashboardNow: (now) => set({ dashboardNow: now }),
  setPtyIdleAgents: (agents) => set(state => ({
    ptyIdleAgents: typeof agents === 'function' ? agents(state.ptyIdleAgents) : agents,
  })),

  resetToHome: () => set({
    selectedAgent: null,
    activeProjectId: null,
    showTaskForm: false,
    showTemplates: false,
    showBatchTemplates: false,
    showUsage: false,
    showSearch: false,
    showProjects: false,
    showSettings: false,
    showDebateForm: false,
    showKnowledgeBase: false,
    showEye: false,
  }),

  closeTerminal: () => set({ selectedAgent: null }),

  // ── Data defaults ─────────────────────────────────────────────────────────
  agents: [],
  jobs: [],
  locks: [],
  templates: [],
  projects: [],
  debates: [],
  workflows: [],
  discussions: [],
  proposals: [],
  archivedJobs: [],
  archivedAgents: [],
  archivedTotal: 0,
  archivedLoading: false,
  watchersByAgent: {},
  commentaryByAgent: {},
  actionsByAgent: {},

  // ── Data actions ──────────────────────────────────────────────────────────
  setAgents: (agents) => set({ agents }),
  addAgent: (agent) => set(state => {
    if (state.agents.some(a => a.id === agent.id)) return state;
    return { agents: [agent, ...state.agents] };
  }),
  updateAgent: (agent) => set(state => {
    const idx = state.agents.findIndex(a => a.id === agent.id);
    if (idx >= 0) {
      const agents = [...state.agents];
      agents[idx] = agent;
      const selectedAgent = state.selectedAgent?.id === agent.id ? agent : state.selectedAgent;
      return { agents, selectedAgent };
    }
    return { agents: [agent, ...state.agents] };
  }),

  setJobs: (jobs) => set({ jobs }),
  addJob: (job) => set(state => {
    if (state.jobs.some(j => j.id === job.id)) return state;
    return { jobs: [job, ...state.jobs] };
  }),
  updateJob: (job) => set(state => {
    const idx = state.jobs.findIndex(j => j.id === job.id);
    if (idx >= 0) {
      const jobs = [...state.jobs];
      jobs[idx] = job;
      const selectedAgent = state.selectedAgent?.job.id === job.id
        ? { ...state.selectedAgent, job }
        : state.selectedAgent;
      return { jobs, selectedAgent };
    }
    return { jobs: [job, ...state.jobs] };
  }),

  setLocks: (locks) => set({ locks }),
  addLock: (lock) => set(state => ({ locks: [...state.locks, lock] })),
  removeLock: (lockId) => set(state => ({ locks: state.locks.filter(l => l.id !== lockId) })),
  purgeExpiredLocks: () => set(state => {
    const now = Date.now();
    const filtered = state.locks.filter(l => l.expires_at > now);
    if (filtered.length === state.locks.length) return state;
    return { locks: filtered };
  }),

  setTemplates: (templates) => set({ templates }),

  setProjects: (projects) => set({ projects }),
  addProject: (project) => set(state => ({
    projects: [...state.projects, project].sort((a, b) => a.name.localeCompare(b.name)),
  })),
  updateProject: (project) => set(state => ({
    projects: state.projects.map(p => p.id === project.id ? project : p),
  })),
  removeProject: (id) => set(state => ({
    projects: state.projects.filter(p => p.id !== id),
    activeProjectId: state.activeProjectId === id ? null : state.activeProjectId,
  })),

  setDebates: (debates) => set({ debates }),
  addDebate: (debate) => set(state => ({ debates: [debate, ...state.debates] })),
  updateDebate: (debate) => set(state => ({
    debates: state.debates.map(d => d.id === debate.id ? debate : d),
  })),

  setWorkflows: (workflows) => set({ workflows }),
  addWorkflow: (workflow) => set(state => ({ workflows: [workflow, ...state.workflows] })),
  updateWorkflow: (workflow) => set(state => ({
    workflows: state.workflows.map(w => w.id === workflow.id ? workflow : w),
  })),

  setDiscussions: (discussions) => set({ discussions }),
  addOrUpdateDiscussion: (discussion) => set(state => ({
    discussions: state.discussions.some(d => d.id === discussion.id)
      ? state.discussions.map(d => d.id === discussion.id ? discussion : d)
      : [discussion, ...state.discussions],
  })),
  setProposals: (proposals) => set({ proposals }),
  addOrUpdateProposal: (proposal) => set(state => ({
    proposals: state.proposals.some(p => p.id === proposal.id)
      ? state.proposals.map(p => p.id === proposal.id ? proposal : p)
      : [proposal, ...state.proposals],
  })),

  setArchivedJobs: (jobs) => set({ archivedJobs: jobs }),
  appendArchivedJobs: (jobs) => set(state => ({ archivedJobs: [...state.archivedJobs, ...jobs] })),
  setArchivedAgents: (agents: AgentWithJob[]) => set({ archivedAgents: agents }),
  appendArchivedAgents: (agents: AgentWithJob[]) => set(state => ({ archivedAgents: [...state.archivedAgents, ...agents] })),
  setArchivedTotal: (total: number) => set({ archivedTotal: total }),
  setArchivedLoading: (loading: boolean) => set({ archivedLoading: loading }),

  upsertWatcher: (watcher) => set(state => ({
    watchersByAgent: { ...state.watchersByAgent, [watcher.agent_id]: watcher },
  })),
  appendWatcherCommentary: (commentary) => set(state => {
    const prev = state.commentaryByAgent[commentary.agent_id] ?? [];
    if (prev.some(c => c.id === commentary.id)) return state;
    // Keep newest at the end, bounded to 500 per agent.
    const next = [...prev, commentary].slice(-500);
    return { commentaryByAgent: { ...state.commentaryByAgent, [commentary.agent_id]: next } };
  }),
  setWatcherCommentary: (agentId, commentary) => set(state => ({
    commentaryByAgent: { ...state.commentaryByAgent, [agentId]: commentary },
  })),
  appendWatcherAction: (action) => set(state => {
    const prev = state.actionsByAgent[action.agent_id] ?? [];
    if (prev.some(a => a.id === action.id)) return state;
    const next = [...prev, action].slice(-200);
    return { actionsByAgent: { ...state.actionsByAgent, [action.agent_id]: next } };
  }),
  setWatcherActions: (agentId, actions) => set(state => ({
    actionsByAgent: { ...state.actionsByAgent, [agentId]: actions },
  })),
}));
