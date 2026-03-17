import React, { useState, useCallback, useEffect, useRef, useMemo, lazy, Suspense } from 'react';
import { Header } from './components/Header';
import { AgentGrid } from './components/AgentGrid';
import { AgentTerminal } from './components/AgentTerminal';
import { WorkQueueSidebar } from './components/WorkQueueSidebar';
import { FileLockMap } from './components/FileLockMap';
import { JobLineagePanel } from './components/JobLineagePanel';
import { RunningJobsPanel } from './components/RunningJobsPanel';
import { EyePanel } from './components/EyePanel';

// Lazy-loaded modal components (only rendered when toggled open)
const JobForm = lazy(() => import('./components/JobForm').then(m => ({ default: m.JobForm })));
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
const KnowledgeBaseModal = lazy(() => import('./components/KnowledgeBaseModal').then(m => ({ default: m.KnowledgeBaseModal })));
import { useSocket } from './hooks/useSocket';
import { useAgents } from './hooks/useAgents';
import { useJobs } from './hooks/useJobs';
import { useLocks } from './hooks/useLocks';
import { useProjects } from './hooks/useProjects';
import { useDebates } from './hooks/useDebates';
import { useToasts } from './hooks/useToasts';
import { ToastFeed } from './components/ToastFeed';
import socket from './socket';
import type { AgentWithJob, AgentOutput, CreateJobRequest, CreateDebateRequest, Debate, Job, Template, BatchTemplate, Discussion, Proposal } from '@shared/types';

export default function App() {
  const { agents, setInitial: setInitialAgents, addAgent, updateAgent } = useAgents();
  const { jobs, setInitial: setInitialJobs, addJob, updateJob } = useJobs();
  const { locks, setInitial: setInitialLocks, addLock, removeLock } = useLocks();
  const { projects, setInitial: setInitialProjects, addProject, updateProject, removeProject } = useProjects();
  const { debates, setInitial: setInitialDebates, addDebate, updateDebate: updateDebateState } = useDebates();
  const { toasts, dismiss: dismissToast } = useToasts();
  const [templates, setTemplates] = useState<Template[]>([]);

  const [selectedAgent, setSelectedAgent] = useState<AgentWithJob | null>(null);
  const [showJobForm, setShowJobForm] = useState(false);
  const [showTemplates, setShowTemplates] = useState(false);
  const [showUsage, setShowUsage] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [showGantt, setShowGantt] = useState(false);
  const [showDag, setShowDag] = useState(false);
  const [showProjects, setShowProjects] = useState(false);
  const [showBatchTemplates, setShowBatchTemplates] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showDebateForm, setShowDebateForm] = useState(false);
  const [debateFormInitial, setDebateFormInitial] = useState<Partial<CreateDebateRequest> | undefined>();
  const [selectedDebate, setSelectedDebate] = useState<Debate | null>(null);
  const [showKnowledgeBase, setShowKnowledgeBase] = useState(false);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [archivedJobs, setArchivedJobs] = useState<Job[]>([]);
  const [archivedAgents, setArchivedAgents] = useState<AgentWithJob[]>([]);
  const [archivedTotal, setArchivedTotal] = useState(0);
  const [archivedLoading, setArchivedLoading] = useState(false);
  const [leftTab, setLeftTab] = useState<'feed' | 'lineage'>('feed');

  const [todayClaudeCost, setTodayClaudeCost] = useState<number | null>(null);
  const [todayCodexCost, setTodayCodexCost] = useState<number | null>(null);
  const [costAutoUpdate, setCostAutoUpdate] = useState(false);
  const [discussions, setDiscussions] = useState<Discussion[]>([]);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [showEye, setShowEye] = useState(false);
  const [eyeEnabled, setEyeEnabled] = useState(false);
  const fetchingCost = useRef(false);

  // Track when PTY data was last received per agent (for idle detection)
  const lastPtyActivity = useRef<Map<string, number>>(new Map());
  const [ptyIdleAgents, setPtyIdleAgents] = useState<Set<string>>(new Set());

  useEffect(() => {
    const handlePtyData = ({ agent_id }: { agent_id: string }) => {
      lastPtyActivity.current.set(agent_id, Date.now());
    };
    socket.on('pty:data', handlePtyData);
    return () => { socket.off('pty:data', handlePtyData); };
  }, []);

  // Poll every second to compute which interactive running agents are idle (no pty output for 3s)
  useEffect(() => {
    const id = setInterval(() => {
      const now = Date.now();
      const idleSet = new Set<string>();
      for (const agent of agents) {
        if (agent.status === 'running' && agent.job.is_interactive) {
          const last = lastPtyActivity.current.get(agent.id);
          if (last !== undefined && now - last > 3000) {
            idleSet.add(agent.id);
          }
        }
      }
      setPtyIdleAgents(prev => {
        // Only update if the set contents changed
        if (prev.size === idleSet.size && [...idleSet].every(id => prev.has(id))) return prev;
        return idleSet;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [agents]);

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
      setTodayClaudeCost(claudeCost);
      setTodayCodexCost(codexCost);
    } catch {
      // ignore — don't show broken state
    } finally {
      fetchingCost.current = false;
    }
  }, []);

  // Fetch today's cost on mount so the spend tracker is always visible
  useEffect(() => { fetchTodayCost(); }, [fetchTodayCost]);

  // When an agent updates, sync the selected agent if it's open; refresh cost when one finishes.
  // Also sync jobs state from the embedded job, since job:update events can be missed when
  // agent events arrive out-of-order or a transition happens entirely within the agent path.
  const handleAgentUpdate = useCallback((agent: AgentWithJob) => {
    updateAgent(agent);
    updateJob(agent.job);
    setSelectedAgent(prev => prev?.id === agent.id ? agent : prev);
    if (costAutoUpdate && (agent.status === 'done' || agent.status === 'failed')) {
      fetchTodayCost();
    }
  }, [updateAgent, updateJob, fetchTodayCost, costAutoUpdate]);

  const handleAgentNew = useCallback((agent: AgentWithJob) => {
    addAgent(agent);
    updateJob(agent.job);
  }, [addAgent, updateJob]);

  useSocket({
    onSnapshot: (snapshot) => {
      setInitialJobs(snapshot.jobs);
      setInitialAgents(snapshot.agents);
      setInitialLocks(snapshot.locks);
      setTemplates(snapshot.templates ?? []);
      setInitialProjects(snapshot.projects ?? []);
      setInitialDebates(snapshot.debates ?? []);
      setDiscussions(snapshot.discussions ?? []);
      setProposals(snapshot.proposals ?? []);
    },
    onAgentNew: handleAgentNew,
    onAgentUpdate: handleAgentUpdate,
    onAgentOutput: (_agentId: string, _line: AgentOutput) => {
      // Output is rendered live in AgentTerminal via socket listener
    },
    onQuestionNew: (question) => {
      // Question state is on the agent; update will come via agent:update
    },
    onQuestionAnswered: (question) => {
      // Same — agent update will follow
    },
    onLockAcquired: addLock,
    onLockReleased: (lockId) => removeLock(lockId),
    onJobNew: addJob,
    onJobUpdate: updateJob,
    onProjectNew: addProject,
    onDebateNew: addDebate,
    onDebateUpdate: updateDebateState,
    onDiscussionNew: (discussion: Discussion) => setDiscussions(prev => [discussion, ...prev.filter(d => d.id !== discussion.id)]),
    onDiscussionUpdate: (discussion: Discussion) => setDiscussions(prev => prev.map(d => d.id === discussion.id ? discussion : d)),
    onProposalNew: (proposal: Proposal) => setProposals(prev => [proposal, ...prev.filter(p => p.id !== proposal.id)]),
    onProposalUpdate: (proposal: Proposal) => setProposals(prev => prev.map(p => p.id === proposal.id ? proposal : p)),
  });

  // Fetch eyeEnabled from settings on mount
  useEffect(() => {
    fetch('/api/settings')
      .then(r => r.ok ? r.json() : {})
      .then((cfg: { eyeEnabled?: boolean }) => setEyeEnabled(cfg.eyeEnabled === true))
      .catch(() => {});
  }, []);

  // Fetch on mount, retry once after 15s (handles ccusage first-install delay on server startup),
  // then every 60s (if auto-update enabled)
  useEffect(() => {
    fetchTodayCost();
    const retryId = setTimeout(fetchTodayCost, 15_000);
    if (!costAutoUpdate) return () => clearTimeout(retryId);
    const id = setInterval(fetchTodayCost, 60_000);
    return () => { clearTimeout(retryId); clearInterval(id); };
  }, [fetchTodayCost, costAutoUpdate]);

  // ─── Load archived jobs when the archived view is active ──────────────────
  const ARCHIVED_PAGE_SIZE = 50;
  useEffect(() => {
    if (activeProjectId !== '__archived__') return;
    setArchivedJobs([]);
    setArchivedAgents([]);
    setArchivedTotal(0);
    fetch(`/api/jobs?archived=1&limit=${ARCHIVED_PAGE_SIZE}&offset=0`)
      .then(r => r.ok ? r.json() : { jobs: [], total: 0, agents: [] })
      .then((data: { jobs: Job[]; total: number; agents?: AgentWithJob[] }) => {
        setArchivedJobs(data.jobs);
        setArchivedAgents(data.agents ?? []);
        setArchivedTotal(data.total);
      })
      .catch(() => {});
  }, [activeProjectId]);

  const loadMoreArchived = useCallback(async () => {
    setArchivedLoading(true);
    try {
      const res = await fetch(`/api/jobs?archived=1&limit=${ARCHIVED_PAGE_SIZE}&offset=${archivedJobs.length}`);
      if (!res.ok) return;
      const data: { jobs: Job[]; total: number; agents?: AgentWithJob[] } = await res.json();
      setArchivedJobs(prev => [...prev, ...data.jobs]);
      setArchivedAgents(prev => [...prev, ...(data.agents ?? [])]);
      setArchivedTotal(data.total);
    } catch { /* ignore */ } finally {
      setArchivedLoading(false);
    }
  }, [archivedJobs.length]);

  // ─── Eye job detection ──────────────────────────────────────────────────
  const isEyeJob = useCallback((j: Job) => {
    try { return j.context != null && JSON.parse(j.context).eye === true; } catch { return false; }
  }, []);

  // ─── Project-scoped filtering ──────────────────────────────────────────────
  const filteredJobs = useMemo(() => {
    if (activeProjectId === '__archived__') return archivedJobs.filter(j => !isEyeJob(j));
    const activeJobs = jobs.filter(j => !j.archived_at && !isEyeJob(j));
    if (activeProjectId) return activeJobs.filter(j => j.project_id === activeProjectId);
    return activeJobs.filter(j => !j.project_id);
  }, [jobs, activeProjectId, archivedJobs, isEyeJob]);

  const filteredJobIds = useMemo(() => new Set(filteredJobs.map(j => j.id)), [filteredJobs]);

  const filteredAgents = useMemo(() => {
    if (activeProjectId === '__archived__') return archivedAgents.filter(a => !isEyeJob(a.job as any));
    const matching = agents.filter(a => filteredJobIds.has(a.job_id));
    // In active view, only show the most recent agent per job (hides superseded/restarted agents)
    const latestByJob = new Map<string, AgentWithJob>();
    for (const a of matching) {
      const existing = latestByJob.get(a.job_id);
      if (!existing || a.started_at > existing.started_at) {
        latestByJob.set(a.job_id, a);
      }
    }
    return [...latestByJob.values()];
  }, [agents, filteredJobIds, activeProjectId, archivedAgents, isEyeJob]);

  const activeProjectName = useMemo(() => {
    if (!activeProjectId) return null;
    if (activeProjectId === '__archived__') return 'Archived';
    return projects.find(p => p.id === activeProjectId)?.name ?? null;
  }, [projects, activeProjectId]);

  const handleCreateProject = useCallback(async (name: string, description: string) => {
    try {
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, description: description || undefined }),
      });
      if (!res.ok) return;
      const project = await res.json();
      addProject(project);
      setActiveProjectId(project.id);
    } catch { /* ignore */ }
  }, [addProject]);

  const handleDeleteProject = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/projects/${id}`, { method: 'DELETE' });
      if (!res.ok) return;
      removeProject(id);
      if (activeProjectId === id) setActiveProjectId(null);
    } catch { /* ignore */ }
  }, [removeProject, activeProjectId]);

  const handleRenameProject = useCallback(async (id: string, newName: string) => {
    try {
      const res = await fetch(`/api/projects/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName }),
      });
      if (!res.ok) return;
      const updated = await res.json();
      updateProject(updated);
    } catch { /* ignore */ }
  }, [updateProject]);

  const handleRenameJob = useCallback(async (jobId: string, newTitle: string) => {
    try {
      const res = await fetch(`/api/jobs/${jobId}/title`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: newTitle }),
      });
      if (!res.ok) return;
      const updated = await res.json();
      updateJob(updated);
      // Keep selectedAgent in sync
      setSelectedAgent(prev => prev && prev.job.id === jobId ? { ...prev, job: updated } : prev);
    } catch { /* ignore */ }
  }, [updateJob]);

  const handleSubmitJob = useCallback(async (req: CreateJobRequest) => {
    const payload = activeProjectId ? { ...req, projectId: activeProjectId } : req;
    const res = await fetch('/api/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error ?? 'Failed to create job');
    }
  }, [activeProjectId]);

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
    // Add the project created for this debate and switch to it
    addProject(data.project);
    setActiveProjectId(data.project.id);
  }, [addProject]);

  const handleSelectAgent = useCallback((agent: AgentWithJob) => {
    setSelectedAgent(agent);
    const canonicalJob = jobs.find(j => j.id === agent.job_id);
    setActiveProjectId(canonicalJob?.project_id ?? agent.job.project_id ?? null);
  }, [jobs]);

  const handleSelectJob = useCallback((job: Job) => {
    const agent = agents.find(a => a.job_id === job.id);
    if (agent) {
      setSelectedAgent(agent);
    }
    setActiveProjectId(job.project_id ?? null);
  }, [agents]);

  const handleCancelJob = useCallback(async (job: Job) => {
    await fetch(`/api/jobs/${job.id}`, { method: 'DELETE' });
  }, []);

  const handleRunJobNow = useCallback(async (job: Job) => {
    await fetch(`/api/jobs/${job.id}/run-now`, { method: 'POST' });
  }, []);

  const handleArchiveJob = useCallback(async (job: Job) => {
    await fetch(`/api/jobs/${job.id}/archive`, { method: 'POST' });
  }, []);

  const handleArchiveAll = useCallback(async (jobs: Job[]) => {
    await Promise.all(jobs.map(j => fetch(`/api/jobs/${j.id}/archive`, { method: 'POST' })));
  }, []);

  const handleCloseTerminal = useCallback(() => {
    setSelectedAgent(null);
    setLeftTab('feed');
  }, []);

  return (
    <div className="app">
      <Header onNewJob={() => setShowJobForm(true)} onTemplates={() => setShowTemplates(true)} onBatchTemplates={() => setShowBatchTemplates(true)} onUsage={() => setShowUsage(true)} onSearch={() => setShowSearch(true)} onTimeline={() => setShowGantt(true)} onDag={() => setShowDag(true)} onProjects={() => setShowProjects(true)} onSettings={() => setShowSettings(true)} onDebate={() => { setDebateFormInitial(undefined); setShowDebateForm(true); }} onDebates={debates.length > 0 ? debates : undefined} onSelectDebate={(d) => setSelectedDebate(d)} onKnowledgeBase={() => setShowKnowledgeBase(true)} onEye={() => setShowEye(v => !v)} eyeEnabled={eyeEnabled} eyeActive={showEye} eyeBadgeCount={showEye ? 0 : discussions.filter(d => d.needs_reply).length + proposals.filter(p => p.needs_reply).length} onHome={() => { setSelectedAgent(null); setActiveProjectId(null); setShowJobForm(false); setShowTemplates(false); setShowBatchTemplates(false); setShowUsage(false); setShowSearch(false); setShowGantt(false); setShowDag(false); setShowProjects(false); setShowSettings(false); setShowDebateForm(false); setShowKnowledgeBase(false); setShowEye(false); }} currentProjectName={activeProjectName} onClearProject={() => setActiveProjectId(null)} todayClaudeCost={todayClaudeCost ?? undefined} todayCodexCost={todayCodexCost ?? undefined} costAutoUpdate={costAutoUpdate} onToggleCostAutoUpdate={() => setCostAutoUpdate(v => !v)} />

      <div className="main-layout">
        <div className={`left-sidebar-stack ${leftTab === 'lineage' && selectedAgent ? '' : 'left-sidebar-stack--narrow'}`}>
          {selectedAgent && (
            <div className="left-sidebar-tabs">
              <button
                className={`left-sidebar-tab ${leftTab === 'feed' ? 'left-sidebar-tab--active' : ''}`}
                onClick={() => setLeftTab('feed')}
              >Feed</button>
              <button
                className={`left-sidebar-tab ${leftTab === 'lineage' ? 'left-sidebar-tab--active' : ''}`}
                onClick={() => setLeftTab('lineage')}
              >Lineage</button>
            </div>
          )}
          {leftTab === 'lineage' && selectedAgent ? (
            <JobLineagePanel
              selectedAgent={selectedAgent}
              allAgents={agents}
              onSelectAgent={handleSelectAgent}
            />
          ) : (
            <WorkQueueSidebar jobs={jobs} projects={projects} onSelectJob={handleSelectJob} onCancelJob={handleCancelJob} onRunJobNow={handleRunJobNow} onArchiveJob={handleArchiveJob} waitingJobIds={new Set(agents.filter(a => a.status === 'waiting_user' || ptyIdleAgents.has(a.id)).map(a => a.job_id))} />
          )}
          <RunningJobsPanel
            agents={agents}
            projects={projects}
            onSelectAgent={handleSelectAgent}
            ptyIdleAgentIds={ptyIdleAgents}
          />
        </div>

        <main className={`agent-main ${selectedAgent ? 'agent-main-split' : ''}`}>
          <AgentGrid agents={filteredAgents} queuedJobs={filteredJobs.filter(j => j.status === 'queued')} onSelectAgent={handleSelectAgent} onArchiveJob={handleArchiveJob} onArchiveAll={handleArchiveAll} templates={templates} selectedAgentId={selectedAgent?.id ?? null} ptyIdleAgentIds={ptyIdleAgents} isArchived={activeProjectId === '__archived__'} />
          {activeProjectId === '__archived__' && archivedJobs.length < archivedTotal && (
            <div style={{ textAlign: 'center', padding: '12px' }}>
              <button className="btn btn-secondary" onClick={loadMoreArchived} disabled={archivedLoading}>
                {archivedLoading ? 'Loading…' : `Load more (${archivedJobs.length} of ${archivedTotal})`}
              </button>
            </div>
          )}
        </main>

        {selectedAgent ? (
          <AgentTerminal
            agent={selectedAgent}
            onClose={handleCloseTerminal}
            onContinued={handleSelectAgent}
            onRenameJob={handleRenameJob}
          />
        ) : (
          <FileLockMap locks={locks} />
        )}
      </div>

      <Suspense fallback={null}>
      {showJobForm && (
        <JobForm
          onSubmit={handleSubmitJob}
          onClose={() => setShowJobForm(false)}
          availableJobs={jobs}
        />
      )}

      {showTemplates && (
        <TemplateManager onClose={() => setShowTemplates(false)} />
      )}

      {showBatchTemplates && (
        <BatchTemplateManager
          onClose={() => setShowBatchTemplates(false)}
          onRun={(project) => {
            setShowBatchTemplates(false);
            addProject(project);
            setActiveProjectId(project.id);
          }}
        />
      )}

      {showUsage && (
        <UsageModal onClose={() => setShowUsage(false)} />
      )}

      {showSearch && (
        <SearchModal
          onClose={() => setShowSearch(false)}
          onSelectAgent={(agentId) => {
            const agent = agents.find(a => a.id === agentId);
            if (agent) { handleSelectAgent(agent); }
            setShowSearch(false);
          }}
        />
      )}

      {showGantt && (
        <GanttModal
          jobs={filteredJobs}
          agents={filteredAgents}
          onClose={() => setShowGantt(false)}
          onSelectAgent={(agent) => {
            handleSelectAgent(agent);
            setShowGantt(false);
          }}
        />
      )}

      {showDag && (
        <DAGModal
          jobs={filteredJobs}
          agents={filteredAgents}
          onClose={() => setShowDag(false)}
          onSelectAgent={(agent) => {
            handleSelectAgent(agent);
            setShowDag(false);
          }}
        />
      )}

      {showSettings && (
        <SettingsModal onClose={() => setShowSettings(false)} eyeEnabled={eyeEnabled} onEyeEnabledChange={setEyeEnabled} />
      )}

      {showDebateForm && (
        <DebateForm
          onSubmit={handleSubmitDebate}
          onClose={() => { setShowDebateForm(false); setDebateFormInitial(undefined); }}
        />
      )}

      {selectedDebate && (
        <DebateDetailModal
          debate={debates.find(d => d.id === selectedDebate.id) ?? selectedDebate}
          agents={agents}
          onClose={() => setSelectedDebate(null)}
          onClone={(_initial) => { setShowDebateForm(true); }}
          onDebateUpdate={updateDebateState}
        />
      )}

      {showKnowledgeBase && (
        <KnowledgeBaseModal onClose={() => setShowKnowledgeBase(false)} />
      )}

      {showEye && (
        <div className="modal-overlay" onClick={() => setShowEye(false)}>
          <div className="modal" style={{ width: '90vw', maxWidth: 1200, height: '80vh' }} onClick={e => e.stopPropagation()}>
            <EyePanel discussions={discussions} proposals={proposals} onClose={() => setShowEye(false)} />
          </div>
        </div>
      )}

      {showProjects && (
        <ProjectSelector
          projects={projects}
          activeProjectId={activeProjectId}
          onSelect={setActiveProjectId}
          onCreate={handleCreateProject}
          onDelete={handleDeleteProject}
          onRename={handleRenameProject}
          onClose={() => setShowProjects(false)}
        />
      )}
      </Suspense>

      <ToastFeed
        toasts={toasts}
        dismiss={dismissToast}
        onSelectAgent={(agentId) => {
          const agent = agents.find(a => a.id === agentId);
          if (agent) handleSelectAgent(agent);
        }}
      />
    </div>
  );
}
