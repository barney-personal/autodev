import React, { memo, useState, useRef, useEffect } from 'react';
import type { Job, Project } from '@shared/types';

function ArchiveIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="1" y="2" width="14" height="3" rx="0.75"/>
      <path d="M2.5 5v8.5a.5.5 0 00.5.5h10a.5.5 0 00.5-.5V5"/>
      <line x1="8" y1="7.5" x2="8" y2="11.5"/>
      <polyline points="6,9.5 8,11.5 10,9.5"/>
    </svg>
  );
}

interface WorkQueueSidebarProps {
  jobs: Job[];
  projects?: Project[];
  onSelectJob?: (job: Job) => void;
  onCancelJob?: (job: Job) => void;
  onRunJobNow?: (job: Job) => void;
  onArchiveJob?: (job: Job) => void;
  waitingJobIds?: Set<string>;
}

interface SidebarFolder {
  id: string;
  name: string;
  jobIds: string[];       // ordered list of job IDs inside this folder
  collapsed: boolean;
  defaultSection: 'active' | 'queued'; // where to show when empty
}

function formatInterval(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}

function formatTimeUntil(ts: number): string {
  const diff = ts - Date.now();
  if (diff <= 0) return 'now';
  if (diff < 60_000) return `${Math.round(diff / 1000)}s`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h`;
  return `${Math.round(diff / 86_400_000)}d`;
}

function loadStorage<T>(key: string, def: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : def;
  } catch {
    return def;
  }
}

export const WorkQueueSidebar = memo(function WorkQueueSidebar({
  jobs, projects = [], onSelectJob, onCancelJob, onRunJobNow, onArchiveJob, waitingJobIds = new Set(),
}: WorkQueueSidebarProps) {
  const projectMap = Object.fromEntries(projects.map(p => [p.id, p.name]));

  // ── Persisted state ────────────────────────────────────────────────────────
  const [folders, setFolders] = useState<SidebarFolder[]>(() =>
    loadStorage('sidebar-folders', [])
  );
  // Per-section ordered token list: 'job:<id>' or 'folder:<id>'
  const [sectionOrder, setSectionOrder] = useState<Record<string, string[]>>(() =>
    loadStorage('sidebar-section-order', {})
  );

  useEffect(() => {
    localStorage.setItem('sidebar-folders', JSON.stringify(folders));
  }, [folders]);
  useEffect(() => {
    localStorage.setItem('sidebar-section-order', JSON.stringify(sectionOrder));
  }, [sectionOrder]);

  // ── Drag state ─────────────────────────────────────────────────────────────
  const [draggingToken, setDraggingToken] = useState<string | null>(null);
  const [dragOverToken, setDragOverToken] = useState<string | null>(null);
  const dragRef = useRef<string | null>(null);

  // ── Rename state ───────────────────────────────────────────────────────────
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameVal, setRenameVal] = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (renamingId && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renamingId]);

  // ── Derived job groups ─────────────────────────────────────────────────────
  const visibleJobs = jobs.filter(j => !j.archived_at);
  const jobMap = new Map(visibleJobs.map(j => [j.id, j]));

  // Eye project: find project named "Eye" to auto-group its jobs
  const eyeProject = projects.find(p => p.name === 'Eye');
  const eyeJobIds = new Set(eyeProject ? visibleJobs.filter(j => j.project_id === eyeProject.id).map(j => j.id) : []);

  const active = visibleJobs.filter(j => (j.status === 'assigned' || j.status === 'running') && !eyeJobIds.has(j.id));
  const queued = visibleJobs.filter(j => j.status === 'queued' && !eyeJobIds.has(j.id));
  const done = visibleJobs
    .filter(j => j.status === 'done' || j.status === 'failed' || j.status === 'cancelled')
    .sort((a, b) => b.updated_at - a.updated_at);

  // Which section should a folder appear in?
  function folderSection(f: SidebarFolder): 'active' | 'queued' | null {
    if (f.jobIds.length === 0) return f.defaultSection;
    let hasActive = false, hasQueued = false;
    for (const id of f.jobIds) {
      const j = jobMap.get(id);
      if (!j) continue;
      if (j.status === 'assigned' || j.status === 'running') hasActive = true;
      else if (j.status === 'queued') hasQueued = true;
    }
    if (hasActive) return 'active';
    if (hasQueued) return 'queued';
    return null; // all jobs terminal → folder disappears
  }

  // Folders with at least one active/queued job, or empty folders
  const visibleFolders = folders.filter(f => {
    if (f.jobIds.length === 0) return true;
    return folderSection(f) !== null;
  });

  // Job IDs that belong to a visible folder (and are active/queued)
  const folderedJobIds = new Set(
    visibleFolders.flatMap(f =>
      f.jobIds.filter(id => {
        const j = jobMap.get(id);
        return j && (j.status === 'assigned' || j.status === 'running' || j.status === 'queued');
      })
    )
  );

  // ── Build ordered item list for a section ──────────────────────────────────
  type SectionItem = { type: 'job'; job: Job } | { type: 'folder'; folder: SidebarFolder };

  function getSectionItems(key: string, sectionJobs: Job[]): SectionItem[] {
    const ungrouped = sectionJobs.filter(j => !folderedJobIds.has(j.id));
    const secFolders = visibleFolders.filter(f => folderSection(f) === key);
    const order = sectionOrder[key] ?? [];
    const seen = new Set<string>();
    const result: SectionItem[] = [];

    for (const tok of order) {
      if (tok.startsWith('job:')) {
        const job = ungrouped.find(j => `job:${j.id}` === tok);
        if (job && !seen.has(tok)) { result.push({ type: 'job', job }); seen.add(tok); }
      } else if (tok.startsWith('folder:')) {
        const folder = secFolders.find(f => `folder:${f.id}` === tok);
        if (folder && !seen.has(tok)) { result.push({ type: 'folder', folder }); seen.add(tok); }
      }
    }
    // Append ungrouped jobs not yet in order
    for (const job of ungrouped) {
      const tok = `job:${job.id}`;
      if (!seen.has(tok)) { result.push({ type: 'job', job }); seen.add(tok); }
    }
    // Append folders not yet in order
    for (const folder of secFolders) {
      const tok = `folder:${folder.id}`;
      if (!seen.has(tok)) { result.push({ type: 'folder', folder }); seen.add(tok); }
    }
    return result;
  }

  // Apply custom order to done jobs
  function getOrderedDone(doneJobs: Job[]): Job[] {
    const order = sectionOrder['done'] ?? [];
    const orderMap = new Map(order.map((tok, i) => [tok, i]));
    return [...doneJobs].sort((a, b) => {
      const ai = orderMap.get(`job:${a.id}`) ?? Infinity;
      const bi = orderMap.get(`job:${b.id}`) ?? Infinity;
      if (ai !== bi) return ai - bi;
      return b.updated_at - a.updated_at;
    });
  }

  // ── Folder operations ──────────────────────────────────────────────────────
  function createFolder(section: 'active' | 'queued') {
    const id = crypto.randomUUID();
    setFolders(prev => [...prev, { id, name: 'New Folder', jobIds: [], collapsed: false, defaultSection: section }]);
    setSectionOrder(prev => ({
      ...prev,
      [section]: [...(prev[section] ?? []), `folder:${id}`],
    }));
    setRenamingId(id);
    setRenameVal('New Folder');
  }

  function deleteFolder(folderId: string) {
    setFolders(prev => prev.filter(f => f.id !== folderId));
    setSectionOrder(prev => {
      const next = { ...prev };
      for (const key of Object.keys(next)) {
        next[key] = next[key].filter(t => t !== `folder:${folderId}`);
      }
      return next;
    });
  }

  function toggleFolder(id: string) {
    setFolders(prev => prev.map(f => f.id === id ? { ...f, collapsed: !f.collapsed } : f));
  }

  function commitRename() {
    if (!renamingId) return;
    const name = renameVal.trim();
    if (name) setFolders(prev => prev.map(f => f.id === renamingId ? { ...f, name } : f));
    setRenamingId(null);
  }

  // ── Drag handlers ──────────────────────────────────────────────────────────
  function dStart(e: React.DragEvent, tok: string) {
    dragRef.current = tok;
    setDraggingToken(tok);
    e.dataTransfer.effectAllowed = 'move';
  }

  function dEnd() {
    setDraggingToken(null);
    setDragOverToken(null);
    dragRef.current = null;
  }

  function dOver(e: React.DragEvent, tok: string) {
    e.preventDefault();
    e.stopPropagation();
    if (dragRef.current !== tok) setDragOverToken(tok);
  }

  function reorderSection(srcTok: string, tgtTok: string, key: string, sectionJobs: Job[]) {
    setSectionOrder(prev => {
      const secFolders = visibleFolders.filter(f => folderSection(f) === key);
      const existing = prev[key] ?? [];
      const existingSet = new Set(existing);
      const allToks = [
        ...existing,
        ...sectionJobs.map(j => `job:${j.id}`).filter(t => !existingSet.has(t)),
        ...secFolders.map(f => `folder:${f.id}`).filter(t => !existingSet.has(t)),
      ];
      const si = allToks.indexOf(srcTok);
      const ti = allToks.indexOf(tgtTok);
      if (si === -1 || ti === -1) return prev;
      const next = [...allToks];
      next.splice(si, 1);
      next.splice(ti, 0, srcTok);
      return { ...prev, [key]: next };
    });
  }

  // Drop on a section-level item (job or folder token)
  function dDropOnItem(e: React.DragEvent, tgtTok: string, key: string, sectionJobs: Job[]) {
    e.preventDefault();
    e.stopPropagation();
    const srcTok = dragRef.current;
    if (!srcTok || srcTok === tgtTok) { setDragOverToken(null); return; }

    const srcJobId = srcTok.startsWith('job:') ? srcTok.slice(4) : null;

    if (srcJobId && tgtTok.startsWith('folder:')) {
      // Add job to folder, remove from all other folders
      const folderId = tgtTok.slice(7);
      setFolders(prev => prev.map(f => {
        if (f.id === folderId) return { ...f, jobIds: [...f.jobIds.filter(id => id !== srcJobId), srcJobId] };
        return { ...f, jobIds: f.jobIds.filter(id => id !== srcJobId) };
      }));
      // Remove job token from section order (it's now inside a folder)
      setSectionOrder(prev => ({
        ...prev,
        [key]: (prev[key] ?? []).filter(t => t !== srcTok),
      }));
    } else {
      // Reorder in section. If source job was in a folder, ungroup it first.
      if (srcJobId) {
        setFolders(prev => prev.map(f => ({ ...f, jobIds: f.jobIds.filter(id => id !== srcJobId) })));
      }
      reorderSection(srcTok, tgtTok, key, sectionJobs);
    }

    setDragOverToken(null);
    dragRef.current = null;
    setDraggingToken(null);
  }

  // Drop on a job that's inside a folder → reorder within folder
  function dDropFolderJob(e: React.DragEvent, folderId: string, tgtJobId: string) {
    e.preventDefault();
    e.stopPropagation();
    const srcTok = dragRef.current;
    if (!srcTok || !srcTok.startsWith('job:')) { setDragOverToken(null); return; }
    const srcJobId = srcTok.slice(4);
    if (srcJobId === tgtJobId) { setDragOverToken(null); return; }

    // Remove srcJob from all other folders, insert it in this folder at target position
    setFolders(prev => prev.map(f => {
      if (f.id !== folderId) return { ...f, jobIds: f.jobIds.filter(id => id !== srcJobId) };
      const withoutSrc = f.jobIds.filter(id => id !== srcJobId);
      const ti = withoutSrc.indexOf(tgtJobId);
      if (ti === -1) return { ...f, jobIds: [...withoutSrc, srcJobId] };
      withoutSrc.splice(ti, 0, srcJobId);
      return { ...f, jobIds: withoutSrc };
    }));
    // Remove from section order if it was ungrouped before
    setSectionOrder(prev => {
      const next = { ...prev };
      for (const key of Object.keys(next)) {
        next[key] = next[key].filter(t => t !== srcTok);
      }
      return next;
    });

    setDragOverToken(null);
    dragRef.current = null;
    setDraggingToken(null);
  }

  // ── Badge components ───────────────────────────────────────────────────────
  const RepeatBadge = ({ job }: { job: Job }) =>
    job.repeat_interval_ms ? (
      <span className="sidebar-job-repeat" title={`Repeats every ${formatInterval(job.repeat_interval_ms)}`}>
        ↻ {formatInterval(job.repeat_interval_ms)}
      </span>
    ) : null;

  const RetryBadge = ({ job }: { job: Job }) =>
    job.original_job_id ? (
      <span className="sidebar-job-retry" title={`Retry ${job.retry_count}/${job.max_retries}`}>
        ↺ {job.retry_count}/{job.max_retries}
      </span>
    ) : null;

  const ScheduledBadge = ({ job }: { job: Job }) => {
    if (!job.scheduled_at || job.scheduled_at <= Date.now()) return null;
    return (
      <span
        className="sidebar-job-scheduled"
        title={`Scheduled in ${formatTimeUntil(job.scheduled_at)} — click to run now`}
        onClick={e => {
          e.stopPropagation();
          if (window.confirm(`Run "${job.title}" now instead of in ${formatTimeUntil(job.scheduled_at!)}?`)) {
            onRunJobNow?.(job);
          }
        }}
      >
        in {formatTimeUntil(job.scheduled_at)}
      </span>
    );
  };

  const ProjectTag = ({ job }: { job: Job }) =>
    job.project_id && projectMap[job.project_id] ? (
      <span className="sidebar-job-project">{projectMap[job.project_id]}</span>
    ) : null;

  const PreDebateBadge = ({ job }: { job: Job }) =>
    job.pre_debate_id && !job.pre_debate_summary && job.status === 'queued' ? (
      <span className="sidebar-job-badge sidebar-job-badge-debate" title="Waiting for pre-debate to finish">⚖ debate</span>
    ) : null;

  // ── Job row renderer ───────────────────────────────────────────────────────
  function jobRow(
    job: Job,
    sectionKey: string,
    sectionJobs: Job[],
    folderCtx?: { folderId: string },
  ) {
    const tok = `job:${job.id}`;
    const isActive = job.status === 'assigned' || job.status === 'running';
    const isWaiting = waitingJobIds.has(job.id);
    const cls = [
      'sidebar-job',
      isActive ? (isWaiting ? 'sidebar-job-waiting' : 'sidebar-job-active') : `sidebar-job-${job.status}`,
      'sidebar-job-clickable',
      'sidebar-job-draggable',
      draggingToken === tok ? 'sidebar-job-dragging' : '',
      dragOverToken === tok ? 'sidebar-job-drag-target' : '',
      folderCtx ? 'sidebar-job-indented' : '',
    ].filter(Boolean).join(' ');

    const dropHandler = folderCtx
      ? (e: React.DragEvent) => dDropFolderJob(e, folderCtx.folderId, job.id)
      : (e: React.DragEvent) => dDropOnItem(e, tok, sectionKey, sectionJobs);

    const dragOverHandler = folderCtx
      ? (e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); if (dragRef.current !== tok) setDragOverToken(tok); }
      : (e: React.DragEvent) => dOver(e, tok);

    return (
      <div
        key={job.id}
        className={cls}
        draggable
        onDragStart={e => dStart(e, tok)}
        onDragEnd={dEnd}
        onDragOver={dragOverHandler}
        onDrop={dropHandler}
        onClick={() => onSelectJob?.(job)}
      >
        <span className="sidebar-drag-handle" onMouseDown={e => e.stopPropagation()}>⠿</span>
        {(job.status === 'done' || job.status === 'failed' || job.status === 'cancelled') && (
          <span className="sidebar-job-bullet">
            {job.status === 'done' ? '✓' : job.status === 'failed' ? '✗' : '⊘'}
          </span>
        )}
        {job.status === 'queued' && <span className="sidebar-job-bullet">•</span>}
        <span className="sidebar-job-title">{job.title}</span>
        <PreDebateBadge job={job} />
        <ScheduledBadge job={job} />
        <RetryBadge job={job} />
        <RepeatBadge job={job} />
        <ProjectTag job={job} />
        {job.pr_url && (
          <a
            href={job.pr_url}
            target="_blank"
            rel="noopener noreferrer"
            className="sidebar-pr-link"
            title="View PR"
            onClick={e => e.stopPropagation()}
          >PR</a>
        )}
        {sectionKey === 'queued' && onCancelJob && (
          <button
            className="sidebar-job-cancel"
            onClick={e => { e.stopPropagation(); onCancelJob(job); }}
            title="Cancel job"
          >✕</button>
        )}
        {['done', 'failed', 'cancelled'].includes(sectionKey) && onArchiveJob && (
          <button
            className="sidebar-job-cancel"
            onClick={e => { e.stopPropagation(); onArchiveJob(job); }}
            title="Archive job"
          ><ArchiveIcon /></button>
        )}
      </div>
    );
  }

  // ── Folder row renderer ────────────────────────────────────────────────────
  function folderRow(folder: SidebarFolder, sectionKey: string, sectionJobs: Job[]) {
    const tok = `folder:${folder.id}`;
    const folderJobs = folder.jobIds
      .map(id => jobMap.get(id))
      .filter((j): j is Job => !!j && sectionJobs.some(s => s.id === j.id));

    const cls = [
      'sidebar-folder',
      draggingToken === tok ? 'sidebar-folder-dragging' : '',
      dragOverToken === tok ? 'sidebar-folder-drag-target' : '',
    ].filter(Boolean).join(' ');

    return (
      <div key={folder.id} className={cls}>
        <div
          className="sidebar-folder-header"
          draggable
          onDragStart={e => dStart(e, tok)}
          onDragEnd={dEnd}
          onDragOver={e => dOver(e, tok)}
          onDrop={e => dDropOnItem(e, tok, sectionKey, sectionJobs)}
        >
          <button
            className="sidebar-folder-toggle"
            onClick={e => { e.stopPropagation(); toggleFolder(folder.id); }}
            title={folder.collapsed ? 'Expand folder' : 'Collapse folder'}
          >
            {folder.collapsed ? '▶' : '▼'}
          </button>
          {renamingId === folder.id ? (
            <input
              ref={renameInputRef}
              className="sidebar-folder-rename-input"
              value={renameVal}
              onChange={e => setRenameVal(e.target.value)}
              onBlur={commitRename}
              onKeyDown={e => {
                if (e.key === 'Enter') commitRename();
                if (e.key === 'Escape') setRenamingId(null);
              }}
              onClick={e => e.stopPropagation()}
            />
          ) : (
            <span
              className="sidebar-folder-name"
              onDoubleClick={e => { e.stopPropagation(); setRenamingId(folder.id); setRenameVal(folder.name); }}
              title="Double-click to rename"
            >
              {folder.name}
            </span>
          )}
          <span className="sidebar-folder-count">{folderJobs.length}</span>
          <button
            className="sidebar-folder-delete"
            onClick={e => { e.stopPropagation(); deleteFolder(folder.id); }}
            title="Remove folder"
          >×</button>
        </div>
        {!folder.collapsed && (
          <div className="sidebar-folder-items">
            {folderJobs.map(j => jobRow(j, sectionKey, sectionJobs, { folderId: folder.id }))}
            {folderJobs.length === 0 && (
              <div className="sidebar-folder-empty-hint">drop jobs here</div>
            )}
          </div>
        )}
      </div>
    );
  }

  // ── Eye virtual folder ─────────────────────────────────────────────────────
  const eyeActiveJobs = visibleJobs.filter(j => eyeJobIds.has(j.id) && (j.status === 'assigned' || j.status === 'running'));
  const eyeQueuedJobs = visibleJobs.filter(j => eyeJobIds.has(j.id) && j.status === 'queued');
  const [eyeFolderCollapsed, setEyeFolderCollapsed] = React.useState(false);

  function eyeFolderRow(eyeJobs: Job[], sectionKey: string) {
    if (eyeJobs.length === 0) return null;
    return (
      <div key="__eye__" className="sidebar-folder">
        <div className="sidebar-folder-header">
          <button
            className="sidebar-folder-toggle"
            onClick={() => setEyeFolderCollapsed(c => !c)}
            title={eyeFolderCollapsed ? 'Expand folder' : 'Collapse folder'}
          >
            {eyeFolderCollapsed ? '▶' : '▼'}
          </button>
          <span className="sidebar-folder-name" title="Eye monitoring jobs">👁 eye</span>
          <span className="sidebar-folder-count">{eyeJobs.length}</span>
        </div>
        {!eyeFolderCollapsed && (
          <div className="sidebar-folder-items">
            {eyeJobs.map(j => jobRow(j, sectionKey, eyeJobs, undefined))}
          </div>
        )}
      </div>
    );
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  const hasActive = active.length > 0 || eyeActiveJobs.length > 0 || visibleFolders.some(f => folderSection(f) === 'active');
  const hasQueued = queued.length > 0 || eyeQueuedJobs.length > 0 || visibleFolders.some(f => folderSection(f) === 'queued');
  const totalActive = active.length + eyeActiveJobs.length;

  return (
    <aside className="sidebar">
      <h2 className="sidebar-title">Activity Feed</h2>

      {hasActive && (
        <div className="sidebar-section">
          <div className="sidebar-section-header">
            <span className="sidebar-section-label">active ({totalActive})</span>
            <button
              className="sidebar-section-folder-btn"
              onClick={() => createFolder('active')}
              title="Create folder"
            >+</button>
          </div>
          {eyeFolderRow(eyeActiveJobs, 'active')}
          {getSectionItems('active', active).map(item =>
            item.type === 'folder'
              ? folderRow(item.folder, 'active', active)
              : jobRow(item.job, 'active', active)
          )}
        </div>
      )}

      {hasQueued && (
        <div className="sidebar-section">
          <div className="sidebar-section-header">
            <span className="sidebar-section-label">queued ({queued.length + eyeQueuedJobs.length})</span>
            <button
              className="sidebar-section-folder-btn"
              onClick={() => createFolder('queued')}
              title="Create folder"
            >+</button>
          </div>
          {eyeFolderRow(eyeQueuedJobs, 'queued')}
          {getSectionItems('queued', queued).map(item =>
            item.type === 'folder'
              ? folderRow(item.folder, 'queued', queued)
              : jobRow(item.job, 'queued', queued)
          )}
        </div>
      )}

      {done.length > 0 && (
        <div className="sidebar-section">
          <div className="sidebar-section-label">done ({done.length})</div>
          {getOrderedDone(done).slice(0, 10).map(job => jobRow(job, 'done', done))}
        </div>
      )}

      {visibleJobs.length === 0 && (
        <p className="sidebar-empty">No jobs yet</p>
      )}
    </aside>
  );
});
