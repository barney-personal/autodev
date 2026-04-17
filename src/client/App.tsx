import { useCallback, useEffect, useRef, useMemo, lazy, Suspense } from 'react';
import { Header } from './components/Header';
import { AgentTerminal } from './components/AgentTerminal';
import { WorkQueueSidebar } from './components/WorkQueueSidebar';
import { FileLockMap } from './components/FileLockMap';
import { JobLineagePanel } from './components/JobLineagePanel';
import { RunningJobsPanel } from './components/RunningJobsPanel';
import { EyePanel } from './components/EyePanel';
import { TaskFeed } from './components/TaskFeed';
import { ErrorBoundary } from './components/ErrorBoundary';

// Lazy-loaded modal components (only rendered when toggled open)
const TaskForm = lazy(() => import('./components/TaskForm').then(m => ({ default: m.TaskForm })));
const TemplateManager = lazy(() => import('./components/TemplateManager').then(m => ({ default: m.TemplateManager })));
const BatchTemplateManager = lazy(() => import('./components/BatchTemplateManager').then(m => ({ default: m.BatchTemplateManager })));
const UsageModal = lazy(() => import('./components/UsageModal').then(m => ({ default: m.UsageModal })));
const SearchModal = lazy(() => import('./components/SearchModal').then(m => ({ default: m.SearchModal })));
const GanttModal = lazy(() => import('./components/GanttModal').then(m => ({ default: m.GanttModal })));
const DAGModal = lazy(() => import('./components/DAGModal').then(m => ({ default: m.DAGModal })));
const ProjectSelector = lazy(() => import('./components/ProjectSelector').then(m => ({ default: m.ProjectSelector })));
const SettingsModal = lazy(() => import('./components/SettingsModal').then(m => ({ default: m.SettingsModal })));
const DebateForm = lazy(() => import('./components/DebateForm').then(m => ({ default: m.DebateForm })));
const DebateDetailModal = lazy(() => import('./components/DebateDetailModal').then(m => ({ default: m.DebateDetailModal })));
const WorkflowDetailModal = lazy(() => import('./components/WorkflowDetailModal').then(m => ({ default: m.WorkflowDetailModal })));
const KnowledgeBaseModal = lazy(() => import('./components/KnowledgeBaseModal').then(m => ({ default: m.KnowledgeBaseModal })));
import { useSocket } from './hooks/useSocket';
import { useToasts } from './hooks/useToasts';
import { ToastFeed } from './components/ToastFeed';
import { useAppStore } from './store';
import socket from './socket';
import type { AgentWithJob, AgentOutput, CreateTaskRequest, CreateDebateRequest, Workflow, Job, Discussion, Proposal } from '@shared/types';

export default function App() {
  // ── Store selectors ─────────────────────────────────────────────────────
  const agents = useAppStore(s => s.agents);
  const jobs = useAppStore(s => s.jobs);
  const locks = useAppStore(s => s.locks);
  const projects = useAppStore(s => s.projects);
  const debates = useAppStore(s => s.debates);
  const workflows = useAppStore(s => s.workflows);
  const discussions = useAppStore(s => s.discussions);
  const proposals = useAppStore(s => s.proposals);

  const selectedAgent = useAppStore(s => s.selectedAgent);
  const selectedDebate = useAppStore(s => s.selectedDebate);
  const selectedWorkflow = useAppStore(s => s.selectedWorkflow);
  const activeProjectId = useAppStore(s => s.activeProjectId);
  const leftTab = useAppStore(s => s.leftTab);

  const showTaskForm = useAppStore(s => s.showTaskForm);
  const showTemplates = useAppStore(s => s.showTemplates);
  const showBatchTemplates = useAppStore(s => s.showBatchTemplates);
  const showUsage = useAppStore(s => s.showUsage);
  const showSearch = useAppStore(s => s.showSearch);
  const showGantt = useAppStore(s => s.showGantt);
  const showDag = useAppStore(s => s.showDag);
  const showProjects = useAppStore(s => s.showProjects);
  const showSettings = useAppStore(s => s.showSettings);
  const showDebateForm = useAppStore(s => s.showDebateForm);
  const showKnowledgeBase = useAppStore(s => s.showKnowledgeBase);
  const showEye = useAppStore(s => s.showEye);
  const eyeEnabled = useAppStore(s => s.eyeEnabled);
  const todayClaudeCost = useAppStore(s => s.todayClaudeCost);
  const todayCodexCost = useAppStore(s => s.todayCodexCost);
  const costAutoUpdate = useAppStore(s => s.costAutoUpdate);
  const ptyIdleAgents = useAppStore(s => s.ptyIdleAgents);

  const archivedJobs = useAppStore(s => s.archivedJobs);
  const archivedAgents = useAppStore(s => s.archivedAgents);
  const archivedTotal = useAppStore(s => s.archivedTotal);
  const archivedLoading = useAppStore(s => s.archivedLoading);

  // ── Store actions (accessed via getState to avoid re-render deps) ───────
  const store = useAppStore;

  const { toasts, dismiss: dismissToast } = useToasts();
  const fetchingCost = useRef(false);

  // Track when PTY data was last received per agent (for idle detection)
  const lastPtyActivity = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    const handlePtyData = ({ agent_id }: { agent_id: string }) => {
      lastPtyActivity.current.set(agent_id, Date.now());
    };
    socket.on('pty:data', handlePtyData);
    return () => { socket.off('pty:data', handlePtyData); };
  }, []);

  // Poll every second to compute which interactive running agents are idle
  useEffect(() => {
    const id = setInterval(() => {
      const now = Date.now();
      const idleSet = new Set<string>();
      const { agents } = store.getState();
      for (const agent of agents) {
        if (agent.status === 'running' && agent.job.is_interactive) {
          const last = lastPtyActivity.current.get(agent.id);
          if (last !== undefined && now - last > 3000) {
            idleSet.add(agent.id);
          }
        }
      }
      store.getState().setPtyIdleAgents(prev => {
        if (prev.size === idleSet.size && [...idleSet].every(id => prev.has(id))) return prev;
        return idleSet;
      });
    }, 1000);
    return () => clearInterval(id);
  }, []);

  const fetchTodayCost = useCallback(async () => {
    if (fetchingCost.current) return;
    fetchingCost.current = true;
    try {
      const d = new Date();
      const since = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
      const res = await fetch(`/api/usage?since=${since}`);
      if (!res.ok) return;
      const data = await res.json();
      const claudeCost = data.totals?.totalCost ?? data.daily?.[0]?.totalCost ?? null;
      const codexCost = data.codex?.totals?.costUSD ?? data.codex?.daily?.[0]?.costUSD ?? null;
      store.getState().setTodayClaudeCost(claudeCost);
      store.getState().setTodayCodexCost(codexCost);
    } catch {
      // ignore
    } finally {
      fetchingCost.current = false;
    }
  }, []);

  useEffect(() => { fetchTodayCost(); }, [fetchTodayCost]);

  const handleAgentUpdate = useCallback((agent: AgentWithJob) => {
    const s = store.getState();
    s.updateAgent(agent);
    s.updateJob(agent.job);
    if (s.costAutoUpdate && (agent.status === 'done' || agent.status === 'failed')) {
      fetchTodayCost();
    }
  }, [fetchTodayCost]);

  const handleAgentNew = useCallback((agent: AgentWithJob) => {
    const s = store.getState();
    s.addAgent(agent);
    s.updateJob(agent.job);
  }, []);

  useSocket({
    onSnapshot: (snapshot) => {
      const s = store.getState();
      s.setJobs(snapshot.jobs);
      s.setAgents(snapshot.agents);
      s.setLocks(snapshot.locks);
      s.setTemplates(snapshot.templates ?? []);
      s.setProjects(snapshot.projects ?? []);
      s.setDebates(snapshot.debates ?? []);
      s.setWorkflows(snapshot.workflows ?? []);
      s.setDiscussions(snapshot.discussions ?? []);
      s.setProposals(snapshot.proposals ?? []);
    },
    onAgentNew: handleAgentNew,
    onAgentUpdate: handleAgentUpdate,
    onAgentOutput: (_agentId: string, _line: AgentOutput) => {},
    onQuestionNew: (_question) => {},
    onQuestionAnswered: (_question) => {},
    onLockAcquired: (lock) => store.getState().addLock(lock),
    onLockReleased: (lockId) => store.getState().removeLock(lockId),
    onJobNew: (job) => store.getState().addJob(job),
    onJobUpdate: (job) => store.getState().updateJob(job),
    onProjectNew: (project) => store.getState().addProject(project),
    onDebateNew: (debate) => store.getState().addDebate(debate),
    onDebateUpdate: (debate) => store.getState().updateDebate(debate),
    onWorkflowNew: (workflow) => store.getState().addWorkflow(workflow),
    onWorkflowUpdate: (workflow) => store.getState().updateWorkflow(workflow),
    onDiscussionNew: (discussion: Discussion) => store.getState().addOrUpdateDiscussion(discussion),
    onDiscussionUpdate: (discussion: Discussion) => store.getState().addOrUpdateDiscussion(discussion),
    onProposalNew: (proposal: Proposal) => store.getState().addOrUpdateProposal(proposal),
    onProposalUpdate: (proposal: Proposal) => store.getState().addOrUpdateProposal(proposal),
  });

  // Fetch eyeEnabled from settings on mount
  useEffect(() => {
    fetch('/api/settings')
      .then(r => r.ok ? r.json() : {})
      .then((cfg: { eyeEnabled?: boolean }) => store.getState().setEyeEnabled(cfg.eyeEnabled === true))
      .catch(() => {});
  }, []);

  // Cost polling
  useEffect(() => {
    fetchTodayCost();
    const retryId = setTimeout(fetchTodayCost, 15_000);
    if (!costAutoUpdate) return () => clearTimeout(retryId);
    const id = setInterval(fetchTodayCost, 60_000);
    return () => { clearTimeout(retryId); clearInterval(id); };
  }, [fetchTodayCost, costAutoUpdate]);

  // Periodic lock resync — poll /api/locks every 3s so the lock list stays
  // current even when socket events are missed (e.g. brief reconnect in dev).
  useEffect(() => {
    const id = setInterval(async () => {
      try {
        const res = await fetch('/api/locks');
        if (res.ok) store.getState().setLocks(await res.json());
      } catch {
        // ignore — leave existing state intact on network error
      }
    }, 3_000);
    return () => clearInterval(id);
  }, []);

  // Safety net: purge any locks whose TTL has expired from local state.
  useEffect(() => {
    const id = setInterval(() => store.getState().purgeExpiredLocks(), 10_000);
    return () => clearInterval(id);
  }, []);

  // ── Load archived jobs ────────────────────────────────────────────────────
  const ARCHIVED_PAGE_SIZE = 50;
  useEffect(() => {
    if (activeProjectId !== '__archived__') return;
    const s = store.getState();
    s.setArchivedJobs([]);
    s.setArchivedAgents([]);
    s.setArchivedTotal(0);
    fetch(`/api/jobs?archived=1&limit=${ARCHIVED_PAGE_SIZE}&offset=0`)
      .then(r => r.ok ? r.json() : { jobs: [], total: 0, agents: [] })
      .then((data: { jobs: Job[]; total: number; agents?: AgentWithJob[] }) => {
        const s2 = store.getState();
        s2.setArchivedJobs(data.jobs);
        s2.setArchivedAgents(data.agents ?? []);
        s2.setArchivedTotal(data.total);
      })
      .catch(() => {});
  }, [activeProjectId]);

  const loadMoreArchived = useCallback(async () => {
    store.getState().setArchivedLoading(true);
    try {
      const currentLen = store.getState().archivedJobs.length;
      const res = await fetch(`/api/jobs?archived=1&limit=${ARCHIVED_PAGE_SIZE}&offset=${currentLen}`);
      if (!res.ok) return;
      const data: { jobs: Job[]; total: number; agents?: AgentWithJob[] } = await res.json();
      const s = store.getState();
      s.appendArchivedJobs(data.jobs);
      s.appendArchivedAgents(data.agents ?? []);
      s.setArchivedTotal(data.total);
    } catch { /* ignore */ } finally {
      store.getState().setArchivedLoading(false);
    }
  }, []);

  // ── Filtering helpers ─────────────────────────────────────────────────────
  const isEyeJob = useCallback((j: Job) => {
    try { return j.context != null && JSON.parse(j.context).eye === true; } catch { return false; }
  }, []);

  const filteredJobs = useMemo(() => {
    if (activeProjectId === '__archived__') return archivedJobs.filter(j => !isEyeJob(j));
    const activeJobs = jobs.filter(j => !j.archived_at && !isEyeJob(j));
    if (activeProjectId) return activeJobs.filter(j => j.project_id === activeProjectId);
    return activeJobs;
  }, [jobs, activeProjectId, archivedJobs, isEyeJob]);

  const filteredJobIds = useMemo(() => new Set(filteredJobs.map(j => j.id)), [filteredJobs]);

  const filteredAgents = useMemo(() => {
    if (activeProjectId === '__archived__') return archivedAgents.filter(a => !isEyeJob(a.job));
    const matching = agents.filter(a => filteredJobIds.has(a.job_id));
    const latestByJob = new Map<string, AgentWithJob>();
    for (const a of matching) {
      const existing = latestByJob.get(a.job_id);
      if (!existing || a.started_at > existing.started_at) latestByJob.set(a.job_id, a);
    }
    return [...latestByJob.values()];
  }, [agents, filteredJobIds, activeProjectId, archivedAgents, isEyeJob]);

  const filteredWorkflows = useMemo(() => {
    if (activeProjectId === '__archived__') return [] as Workflow[];
    if (activeProjectId) return workflows.filter(w => w.project_id === activeProjectId);
    return workflows;
  }, [workflows, activeProjectId]);

  const queuedFilteredJobs = useMemo(
    () => filteredJobs.filter(j => j.status === 'queued'),
    [filteredJobs],
  );

  const waitingJobIds = useMemo(
    () => new Set(
      agents
        .filter(a => a.status === 'waiting_user' || ptyIdleAgents.has(a.id))
        .map(a => a.job_id),
    ),
    [agents, ptyIdleAgents],
  );

  const taskFeedNow = useMemo(
    () => Date.now(),
    [activeProjectId, filteredAgents, filteredJobs, filteredWorkflows],
  );

  const activeProjectName = useMemo(() => {
    if (!activeProjectId) return null;
    if (activeProjectId === '__archived__') return 'Archived';
    return projects.find(p => p.id === activeProjectId)?.name ?? null;
  }, [projects, activeProjectId]);

  // ── Handlers ──────────────────────────────────────────────────────────────
  const handleCreateProject = useCallback(async (name: string, description: string) => {
    try {
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, description: description || undefined }),
      });
      if (!res.ok) return;
      const project = await res.json();
      const s = store.getState();
      s.addProject(project);
      s.setActiveProjectId(project.id);
    } catch { /* ignore */ }
  }, []);

  const handleDeleteProject = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/projects/${id}`, { method: 'DELETE' });
      if (!res.ok) return;
      store.getState().removeProject(id);
    } catch { /* ignore */ }
  }, []);

  const handleRenameProject = useCallback(async (id: string, newName: string) => {
    try {
      const res = await fetch(`/api/projects/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName }),
      });
      if (!res.ok) return;
      store.getState().updateProject(await res.json());
    } catch { /* ignore */ }
  }, []);

  const handleRenameJob = useCallback(async (jobId: string, newTitle: string) => {
    try {
      const res = await fetch(`/api/jobs/${jobId}/title`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: newTitle }),
      });
      if (!res.ok) return;
      store.getState().updateJob(await res.json());
    } catch { /* ignore */ }
  }, []);

  const handleSubmitTask = useCallback(async (req: CreateTaskRequest) => {
    const currentProjectId = store.getState().activeProjectId;
    const isJobRoute = !req.iterations || req.iterations <= 1;
    const payload = currentProjectId && isJobRoute ? { ...req, projectId: currentProjectId } : req;
    const res = await fetch('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error ?? 'Failed to create task');
    }
    const data = await res.json();
    if (data.task_type === 'workflow' && data.project) {
      const s = store.getState();
      s.addProject(data.project);
      s.setActiveProjectId(data.project.id);
    }
  }, []);

  const handleSubmitDebate = useCallback(async (req: CreateDebateRequest) => {
    const res = await fetch('/api/debates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error ?? 'Failed to create debate');
    }
    const data = await res.json();
    const s = store.getState();
    s.addProject(data.project);
    s.setActiveProjectId(data.project.id);
  }, []);

  const handleSelectAgent = useCallback((agent: AgentWithJob) => {
    const s = store.getState();
    s.setSelectedAgent(agent);
    const canonicalJob = s.jobs.find(j => j.id === agent.job_id);
    s.setActiveProjectId(canonicalJob?.project_id ?? agent.job.project_id ?? null);
  }, []);

  const handleSelectJob = useCallback((job: Job) => {
    const s = store.getState();
    const agent = s.agents.find(a => a.job_id === job.id);
    if (agent) s.setSelectedAgent(agent);
    s.setActiveProjectId(job.project_id ?? null);
  }, []);

  const handleCancelJob = useCallback(async (job: Job) => {
    await fetch(`/api/jobs/${job.id}`, { method: 'DELETE' });
  }, []);

  const handleRunJobNow = useCallback(async (job: Job) => {
    await fetch(`/api/jobs/${job.id}/run-now`, { method: 'POST' });
  }, []);

  const handleArchiveJob = useCallback(async (job: Job) => {
    await fetch(`/api/jobs/${job.id}/archive`, { method: 'POST' });
  }, []);

  const handleArchiveAll = useCallback(async (jobsToArchive: Job[]) => {
    await Promise.all(jobsToArchive.map(j => fetch(`/api/jobs/${j.id}/archive`, { method: 'POST' })));
  }, []);

  const handleCloseTerminal = useCallback(() => {
    store.getState().closeTerminal();
  }, []);

  return (
    <div className="app">
      <Header onNewTask={() => store.getState().setShowTaskForm(true)} onTemplates={() => store.getState().setShowTemplates(true)} onBatchTemplates={() => store.getState().setShowBatchTemplates(true)} onUsage={() => store.getState().setShowUsage(true)} onSearch={() => store.getState().setShowSearch(true)} onTimeline={() => store.getState().setShowGantt(true)} onDag={() => store.getState().setShowDag(true)} onProjects={() => store.getState().setShowProjects(true)} onSettings={() => store.getState().setShowSettings(true)} onDebate={() => { store.getState().setDebateFormInitial(undefined); store.getState().setShowDebateForm(true); }} onDebates={debates.length > 0 ? debates : undefined} onSelectDebate={(d) => store.getState().setSelectedDebate(d)} onWorkflows={workflows.length > 0 ? workflows : undefined} onSelectWorkflow={(w) => store.getState().setSelectedWorkflow(w)} onKnowledgeBase={() => store.getState().setShowKnowledgeBase(true)} onEye={() => store.getState().setShowEye(v => !v)} eyeEnabled={eyeEnabled} eyeActive={showEye} eyeBadgeCount={showEye ? 0 : discussions.filter(d => d.needs_reply).length + proposals.filter(p => p.needs_reply).length} onHome={() => store.getState().resetToHome()} currentProjectName={activeProjectName} onClearProject={() => store.getState().setActiveProjectId(null)} todayClaudeCost={todayClaudeCost ?? undefined} todayCodexCost={todayCodexCost ?? undefined} costAutoUpdate={costAutoUpdate} onToggleCostAutoUpdate={() => store.getState().setCostAutoUpdate(v => !v)} />

      <div className="main-layout">
        <ErrorBoundary section="sidebar">
          <div className={`left-sidebar-stack ${leftTab === 'lineage' && selectedAgent ? '' : 'left-sidebar-stack--narrow'}`}>
            {selectedAgent && (
              <div className="left-sidebar-tabs">
                <button
                  className={`left-sidebar-tab ${leftTab === 'feed' ? 'left-sidebar-tab--active' : ''}`}
                  onClick={() => store.getState().setLeftTab('feed')}
                >Feed</button>
                <button
                  className={`left-sidebar-tab ${leftTab === 'lineage' ? 'left-sidebar-tab--active' : ''}`}
                  onClick={() => store.getState().setLeftTab('lineage')}
                >Lineage</button>
              </div>
            )}
            {leftTab === 'lineage' && selectedAgent ? (
              <JobLineagePanel selectedAgent={selectedAgent} allAgents={agents} onSelectAgent={handleSelectAgent} />
            ) : (
              <WorkQueueSidebar jobs={jobs} projects={projects} onSelectJob={handleSelectJob} onCancelJob={handleCancelJob} onRunJobNow={handleRunJobNow} onArchiveJob={handleArchiveJob} waitingJobIds={waitingJobIds} />
            )}
            <RunningJobsPanel agents={agents} projects={projects} onSelectAgent={handleSelectAgent} ptyIdleAgentIds={ptyIdleAgents} />
          </div>
        </ErrorBoundary>

        <ErrorBoundary section="task feed">
          <main className={`agent-main ${selectedAgent ? 'agent-main-split' : ''}`}>
            <section className="dashboard-home-section">
              <div className="dashboard-home-section-header">
                <div>
                  <h2 className="dashboard-home-section-title">Tasks</h2>
                  <p className="dashboard-home-section-subtitle">All workflows and standalone jobs, grouped by urgency.</p>
                </div>
              </div>
              <TaskFeed
                workflows={filteredWorkflows}
                agents={filteredAgents}
                allAgents={agents}
                jobs={filteredJobs}
                queuedJobs={queuedFilteredJobs}
                now={taskFeedNow}
                onSelectAgent={handleSelectAgent}
                onSelectWorkflow={store.getState().setSelectedWorkflow}
                onArchiveJob={handleArchiveJob}
                onArchiveAll={handleArchiveAll}
                selectedAgentId={selectedAgent?.id ?? null}
                ptyIdleAgentIds={ptyIdleAgents}
                isArchived={activeProjectId === '__archived__'}
              />
            </section>
            {activeProjectId === '__archived__' && archivedJobs.length < archivedTotal && (
              <div style={{ textAlign: 'center', padding: '12px' }}>
                <button className="btn btn-secondary" onClick={loadMoreArchived} disabled={archivedLoading}>
                  {archivedLoading ? 'Loading\u2026' : `Load more (${archivedJobs.length} of ${archivedTotal})`}
                </button>
              </div>
            )}
          </main>
        </ErrorBoundary>

        <ErrorBoundary section="terminal">
          {selectedAgent ? (
            <AgentTerminal agent={selectedAgent} onClose={handleCloseTerminal} onContinued={handleSelectAgent} onRenameJob={handleRenameJob} />
          ) : (
            <FileLockMap locks={locks} />
          )}
        </ErrorBoundary>
      </div>

      <Suspense fallback={null}>
      {showTaskForm && (
        <TaskForm onSubmit={handleSubmitTask} onClose={() => store.getState().setShowTaskForm(false)} availableJobs={jobs} />
      )}
      {showTemplates && (
        <TemplateManager onClose={() => store.getState().setShowTemplates(false)} />
      )}
      {showBatchTemplates && (
        <BatchTemplateManager
          onClose={() => store.getState().setShowBatchTemplates(false)}
          onRun={(project) => {
            const s = store.getState();
            s.setShowBatchTemplates(false);
            s.addProject(project);
            s.setActiveProjectId(project.id);
          }}
        />
      )}
      {showUsage && (
        <UsageModal onClose={() => store.getState().setShowUsage(false)} />
      )}
      {showSearch && (
        <SearchModal
          onClose={() => store.getState().setShowSearch(false)}
          onSelectAgent={(agentId) => {
            const agent = store.getState().agents.find(a => a.id === agentId);
            if (agent) handleSelectAgent(agent);
            store.getState().setShowSearch(false);
          }}
        />
      )}
      {showGantt && (
        <GanttModal
          jobs={filteredJobs}
          agents={filteredAgents}
          onClose={() => store.getState().setShowGantt(false)}
          onSelectAgent={(agent) => { handleSelectAgent(agent); store.getState().setShowGantt(false); }}
        />
      )}
      {showDag && (
        <DAGModal
          jobs={filteredJobs}
          agents={filteredAgents}
          onClose={() => store.getState().setShowDag(false)}
          onSelectAgent={(agent) => { handleSelectAgent(agent); store.getState().setShowDag(false); }}
        />
      )}
      {showSettings && (
        <SettingsModal onClose={() => store.getState().setShowSettings(false)} eyeEnabled={eyeEnabled} onEyeEnabledChange={store.getState().setEyeEnabled} />
      )}
      {selectedWorkflow && (
        <WorkflowDetailModal
          workflow={workflows.find(w => w.id === selectedWorkflow.id) ?? selectedWorkflow}
          agents={agents}
          onClose={() => store.getState().setSelectedWorkflow(null)}
          onWorkflowUpdate={store.getState().updateWorkflow}
        />
      )}
      {showDebateForm && (
        <DebateForm
          initial={store.getState().debateFormInitial}
          onSubmit={handleSubmitDebate}
          onClose={() => { store.getState().setShowDebateForm(false); store.getState().setDebateFormInitial(undefined); }}
        />
      )}
      {selectedDebate && (
        <DebateDetailModal
          debate={debates.find(d => d.id === selectedDebate.id) ?? selectedDebate}
          agents={agents}
          onClose={() => store.getState().setSelectedDebate(null)}
          onClone={(initial) => { const s = store.getState(); s.setDebateFormInitial(initial); s.setSelectedDebate(null); s.setShowDebateForm(true); }}
          onDebateUpdate={store.getState().updateDebate}
        />
      )}
      {showKnowledgeBase && (
        <KnowledgeBaseModal onClose={() => store.getState().setShowKnowledgeBase(false)} />
      )}
      {showEye && (
        <div className="modal-overlay" onClick={() => store.getState().setShowEye(false)}>
          <div className="modal" style={{ width: '90vw', maxWidth: 1200, height: '80vh' }} onClick={e => e.stopPropagation()}>
            <EyePanel discussions={discussions} proposals={proposals} onClose={() => store.getState().setShowEye(false)} />
          </div>
        </div>
      )}
      {showProjects && (
        <ProjectSelector
          projects={projects}
          activeProjectId={activeProjectId}
          onSelect={store.getState().setActiveProjectId}
          onCreate={handleCreateProject}
          onDelete={handleDeleteProject}
          onRename={handleRenameProject}
          onClose={() => store.getState().setShowProjects(false)}
        />
      )}
      </Suspense>

      <ToastFeed
        toasts={toasts}
        dismiss={dismissToast}
        onSelectAgent={(agentId) => {
          const agent = store.getState().agents.find(a => a.id === agentId);
          if (agent) handleSelectAgent(agent);
        }}
      />
    </div>
  );
}
