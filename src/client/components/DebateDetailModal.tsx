import { useState, useEffect, useCallback } from 'react';
import type { Debate, Job, AgentWithJob, CreateDebateRequest } from '@shared/types';

interface DebateDetailModalProps {
  debate: Debate;
  agents: AgentWithJob[];
  onClose: () => void;
  onClone: (req: Partial<CreateDebateRequest>) => void;
  onDebateUpdate: (debate: Debate) => void;
}

interface LoopGroup {
  loop: number;
  rounds: RoundGroup[];
  postAction: Job | null;
  verificationJobs: Job[];
}

interface RoundGroup {
  round: number;
  claude: Job | null;
  codex: Job | null;
}

function groupJobsByLoop(jobs: Job[]): LoopGroup[] {
  const loopMap = new Map<number, LoopGroup>();
  for (const job of jobs) {
    const loop = job.debate_loop ?? 0;
    if (!loopMap.has(loop)) loopMap.set(loop, { loop, rounds: [], postAction: null, verificationJobs: [] });
    const group = loopMap.get(loop)!;
    if (job.debate_role === 'post_action') {
      group.postAction = job;
    } else if (job.debate_role === 'verification_review' || job.debate_role === 'verification_response') {
      group.verificationJobs.push(job);
    } else {
      const round = job.debate_round ?? 0;
      let rg = group.rounds.find(r => r.round === round);
      if (!rg) { rg = { round, claude: null, codex: null }; group.rounds.push(rg); }
      if (job.debate_role === 'claude') rg.claude = job;
      else if (job.debate_role === 'codex') rg.codex = job;
    }
  }
  const result = [...loopMap.values()].sort((a, b) => a.loop - b.loop);
  for (const lg of result) lg.rounds.sort((a, b) => a.round - b.round);
  return result;
}


function StatusDot({ status }: { status: string }) {
  const color =
    status === 'done' ? 'var(--status-done)' :
    status === 'failed' ? 'var(--status-failed)' :
    status === 'cancelled' ? 'var(--status-failed)' :
    status === 'running' || status === 'assigned' ? 'var(--status-running)' :
    'var(--text-dim)';
  return <span style={{ display: 'inline-block', width: 7, height: 7, borderRadius: '50%', background: color, marginRight: 6, flexShrink: 0 }} />;
}

function InlineOutput({ agentId, jobStatus }: { agentId: string; jobStatus: string }) {
  const [text, setText] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/agents/${agentId}/result-text`)
      .then(r => r.ok ? r.json() : { text: null })
      .then((data: { text: string | null }) => setText(data.text))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [agentId]);

  if (loading) return <div style={{ padding: '8px 12px', fontSize: 12, color: 'var(--text-dim)' }}>Loading…</div>;
  if (!text) {
    const msg = jobStatus === 'done' || jobStatus === 'failed' ? 'No result text found.' : 'Agent has not produced output yet.';
    return <div style={{ padding: '8px 12px', fontSize: 12, color: 'var(--text-dim)', fontStyle: 'italic' }}>{msg}</div>;
  }
  return (
    <pre style={{
      margin: 0, padding: '10px 14px', fontSize: 12, lineHeight: 1.6,
      color: 'var(--text-primary)', background: 'var(--bg-surface)',
      whiteSpace: 'pre-wrap', wordBreak: 'break-word', overflowX: 'hidden',
      borderTop: '1px solid var(--border)',
    }}>
      {text}
    </pre>
  );
}

function JobRow({
  job, agents, selectedJobId, onSelect,
}: {
  job: Job;
  agents: AgentWithJob[];
  selectedJobId: string | null;
  onSelect: (jobId: string) => void;
}) {
  const agent = agents.find(a => a.job_id === job.id);
  const isSelected = selectedJobId === job.id;
  const label =
    job.debate_role === 'claude' ? 'Claude' :
    job.debate_role === 'codex' ? 'Codex' :
    job.debate_role === 'post_action' ? 'Post-Action' :
    job.debate_role === 'verification_review' ? 'Verif. Review' :
    job.debate_role === 'verification_response' ? 'Verif. Response' :
    job.debate_role ?? '?';

  const canExpand = agent && (job.status === 'done' || job.status === 'failed' || job.status === 'running' || job.status === 'assigned');

  return (
    <div style={{ borderRadius: 6, border: isSelected ? '1px solid var(--border)' : '1px solid transparent', overflow: 'hidden' }}>
      <div
        style={{
          display: 'flex', alignItems: 'center', padding: '5px 8px',
          cursor: canExpand ? 'pointer' : 'default',
          background: isSelected ? 'var(--bg-elevated)' : 'transparent',
          transition: 'background 0.1s',
        }}
        onMouseEnter={e => { if (canExpand && !isSelected) (e.currentTarget as HTMLDivElement).style.background = 'var(--border)'; }}
        onMouseLeave={e => { if (!isSelected) (e.currentTarget as HTMLDivElement).style.background = 'transparent'; }}
        onClick={() => canExpand && onSelect(isSelected ? '' : job.id)}
        title={canExpand ? (isSelected ? 'Collapse output' : 'Show result inline') : 'No output yet'}
      >
        <StatusDot status={job.status} />
        <span style={{ fontSize: 12, color: 'var(--text-secondary)', minWidth: 130 }}>{label}</span>
        <span style={{ fontSize: 12, color: 'var(--text-dim)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {job.title}
        </span>
        {canExpand && (
          <span style={{ fontSize: 10, color: 'var(--text-dim)', marginLeft: 8, flexShrink: 0 }}>{isSelected ? '▴' : '▾'}</span>
        )}
        <span style={{ fontSize: 11, color: 'var(--text-dim)', marginLeft: 6, flexShrink: 0 }}>{job.status}</span>
      </div>
      {isSelected && agent && (
        <InlineOutput agentId={agent.id} jobStatus={job.status} />
      )}
    </div>
  );
}

export function DebateDetailModal({ debate, agents, onClose, onClone, onDebateUpdate }: DebateDetailModalProps) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedLoops, setExpandedLoops] = useState<Set<number>>(new Set([debate.current_loop]));
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);

  const [editLoops, setEditLoops] = useState(String(debate.loop_count));
  const [editMaxRounds, setEditMaxRounds] = useState(String(debate.max_rounds));
  const [editTask, setEditTask] = useState(debate.task);
  const [editPostAction, setEditPostAction] = useState(debate.post_action_prompt ?? '');
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState('');

  const fetchJobs = useCallback(async () => {
    try {
      const res = await fetch(`/api/debates/${debate.id}/jobs`);
      if (res.ok) setJobs(await res.json());
    } catch { /* ignore */ }
    setLoading(false);
  }, [debate.id]);

  useEffect(() => { fetchJobs(); }, [fetchJobs]);

  useEffect(() => {
    setExpandedLoops(prev => new Set([...prev, debate.current_loop]));
  }, [debate.current_loop]);

  const loopGroups = groupJobsByLoop(jobs);

  const isOngoing = !loading && jobs.some(
    j => j.status === 'queued' || j.status === 'assigned' || j.status === 'running'
  );

  const isDirty =
    editLoops !== String(debate.loop_count) ||
    editMaxRounds !== String(debate.max_rounds) ||
    editTask !== debate.task ||
    editPostAction !== (debate.post_action_prompt ?? '');

  const handleSave = async () => {
    setSaving(true);
    setSaveMsg('');
    try {
      const body: Record<string, unknown> = {};
      if (editLoops !== String(debate.loop_count)) body.loopCount = Number(editLoops);
      if (editMaxRounds !== String(debate.max_rounds)) body.maxRounds = Number(editMaxRounds);
      if (editTask !== debate.task) body.task = editTask;
      if (editPostAction !== (debate.post_action_prompt ?? '')) body.postActionPrompt = editPostAction || null;
      const res = await fetch(`/api/debates/${debate.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setSaveMsg((err as { error?: string }).error ?? 'Save failed');
      } else {
        onDebateUpdate(await res.json());
        setSaveMsg('Saved');
        setTimeout(() => setSaveMsg(''), 2000);
      }
    } finally { setSaving(false); }
  };

  const [confirmCancel, setConfirmCancel] = useState(false);

  const handleCancel = async () => {
    const res = await fetch(`/api/debates/${debate.id}/cancel`, { method: 'POST' });
    if (res.ok) { setConfirmCancel(false); onDebateUpdate(await res.json()); }
  };

  const handleClone = () => {
    onClone({
      title: debate.title, task: debate.task,
      claudeModel: debate.claude_model, codexModel: debate.codex_model,
      maxRounds: debate.max_rounds, workDir: debate.work_dir ?? undefined,
      templateId: debate.template_id ?? undefined,
      postActionPrompt: debate.post_action_prompt ?? undefined, loopCount: debate.loop_count,
    });
    onClose();
  };

  const toggleLoop = (loop: number) => {
    setExpandedLoops(prev => {
      const next = new Set(prev);
      if (next.has(loop)) next.delete(loop); else next.add(loop);
      return next;
    });
  };

  const handleSelectJob = (jobId: string) => setSelectedJobId(jobId || null);

  const statusColor = isOngoing ? 'var(--status-running)' :
    debate.status === 'consensus' ? 'var(--status-done)' :
    debate.status === 'cancelled' || debate.status === 'failed' ? 'var(--status-failed)' :
    '#a78bfa';
  const statusLabel = isOngoing ? 'running' : debate.status;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal"
        style={{ width: 860, maxWidth: '95vw', maxHeight: '90vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="modal-header" style={{ gap: 12 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <h2 style={{ margin: 0, fontSize: 15, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{debate.title}</h2>
              <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 99, flexShrink: 0, background: statusColor + '22', color: statusColor, border: `1px solid ${statusColor}44` }}>
                {statusLabel}
              </span>
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 3 }}>
              Loop {debate.current_loop + 1}&thinsp;/&thinsp;{debate.loop_count}
              &ensp;&bull;&ensp;Round {debate.current_round}&thinsp;/&thinsp;{debate.max_rounds}
              &ensp;&bull;&ensp;{debate.claude_model} vs {debate.codex_model}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 6, flexShrink: 0, alignItems: 'center' }}>
            {isOngoing && !confirmCancel && (
              <button className="btn btn-secondary" style={{ fontSize: 12, padding: '4px 10px' }} onClick={() => setConfirmCancel(true)}>Cancel</button>
            )}
            {isOngoing && confirmCancel && (
              <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>Cancel debate?</span>
                <button className="btn" style={{ fontSize: 12, padding: '4px 10px', background: 'var(--status-failed)', color: '#fff', border: 'none' }} onClick={handleCancel}>Yes, cancel</button>
                <button className="btn btn-secondary" style={{ fontSize: 12, padding: '4px 10px' }} onClick={() => setConfirmCancel(false)}>No</button>
              </span>
            )}
            <button className="btn btn-secondary" style={{ fontSize: 12, padding: '4px 10px' }} onClick={handleClone} title="Open debate form pre-filled with this debate's settings">Clone</button>
            <button className="btn-icon" onClick={onClose}>&times;</button>
          </div>
        </div>

        {/* Scrollable content */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 20 }}>

          {/* Settings */}
          <section>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-dim)', marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Settings</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
              <div className="form-group">
                <label style={{ fontSize: 12 }}>Total Loops</label>
                <input type="number" min={1} max={99} value={editLoops} onChange={e => setEditLoops(e.target.value)} style={{ fontSize: 13 }} />
              </div>
              <div className="form-group">
                <label style={{ fontSize: 12 }}>Max Rounds per Loop</label>
                <input type="number" min={1} max={10} value={editMaxRounds} onChange={e => setEditMaxRounds(e.target.value)} style={{ fontSize: 13 }} />
              </div>
            </div>
            <div className="form-group" style={{ marginBottom: 10 }}>
              <label style={{ fontSize: 12 }}>Task Prompt</label>
              <textarea rows={5} value={editTask} onChange={e => setEditTask(e.target.value)} style={{ fontSize: 12, fontFamily: 'inherit', resize: 'vertical' }} />
            </div>
            <div className="form-group">
              <label style={{ fontSize: 12 }}>
                Post-Debate / Verification Prompt
                <span style={{ color: 'var(--text-dim)', fontWeight: 400, marginLeft: 4 }}>(optional)</span>
              </label>
              <textarea rows={3} value={editPostAction} onChange={e => setEditPostAction(e.target.value)}
                style={{ fontSize: 12, fontFamily: 'inherit', resize: 'vertical' }}
                placeholder="e.g. Implement what you agreed upon" />
            </div>
            {isDirty && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10 }}>
                <button className="btn btn-primary" style={{ fontSize: 12, padding: '5px 12px' }} onClick={handleSave} disabled={saving}>
                  {saving ? 'Saving…' : 'Save Changes'}
                </button>
                <button className="btn btn-secondary" style={{ fontSize: 12, padding: '5px 12px' }} onClick={() => {
                  setEditLoops(String(debate.loop_count));
                  setEditMaxRounds(String(debate.max_rounds));
                  setEditTask(debate.task);
                  setEditPostAction(debate.post_action_prompt ?? '');
                }}>Revert</button>
                {saveMsg && <span style={{ fontSize: 12, color: saveMsg === 'Saved' ? 'var(--status-done)' : '#ef4444' }}>{saveMsg}</span>}
              </div>
            )}
          </section>

          {/* Loops */}
          <section>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-dim)', marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
              Loops {!loading && `(${loopGroups.length})`}
            </div>
            {loading ? (
              <div style={{ fontSize: 13, color: 'var(--text-dim)' }}>Loading…</div>
            ) : loopGroups.length === 0 ? (
              <div style={{ fontSize: 13, color: 'var(--text-dim)' }}>No jobs yet</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                {loopGroups.map(lg => {
                  const isOpen = expandedLoops.has(lg.loop);
                  const isCurrent = lg.loop === debate.current_loop && debate.status === 'running';
                  return (
                    <div key={lg.loop} style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
                      <button
                        onClick={() => toggleLoop(lg.loop)}
                        style={{
                          width: '100%', display: 'flex', alignItems: 'center', gap: 8,
                          padding: '8px 12px', background: 'var(--bg-elevated)', border: 'none',
                          cursor: 'pointer', color: 'inherit', textAlign: 'left',
                        }}
                      >
                        <span style={{ fontSize: 10, color: 'var(--text-dim)', width: 10 }}>{isOpen ? '▾' : '▸'}</span>
                        <span style={{ fontSize: 13, fontWeight: 500 }}>Loop {lg.loop + 1}</span>
                        {isCurrent && (
                          <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 99, background: 'var(--status-running-bg)', color: 'var(--status-running)', border: '1px solid rgba(245,158,11,0.3)' }}>current</span>
                        )}
                        <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-dim)' }}>
                          {lg.rounds.length} round{lg.rounds.length !== 1 ? 's' : ''}
                          {lg.postAction ? ' · post-action' : ''}
                          {lg.verificationJobs.length > 0 ? ` · ${lg.verificationJobs.length} verif.` : ''}
                        </span>
                      </button>

                      {isOpen && (
                        <div style={{ padding: '6px 8px', borderTop: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 8 }}>
                          {lg.rounds.map(rg => (
                            <div key={rg.round}>
                              <div style={{ fontSize: 10, color: 'var(--text-dim)', marginBottom: 3, paddingLeft: 2, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                                Round {rg.round + 1}
                              </div>
                              {rg.claude && <JobRow job={rg.claude} agents={agents} selectedJobId={selectedJobId} onSelect={handleSelectJob} />}
                              {rg.codex && <JobRow job={rg.codex} agents={agents} selectedJobId={selectedJobId} onSelect={handleSelectJob} />}
                            </div>
                          ))}
                          {lg.postAction && (
                            <div style={{ borderTop: lg.rounds.length > 0 ? '1px solid var(--border)' : undefined, paddingTop: lg.rounds.length > 0 ? 8 : 0 }}>
                              <div style={{ fontSize: 10, color: 'var(--text-dim)', marginBottom: 3, paddingLeft: 2, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Post-Action</div>
                              <JobRow job={lg.postAction} agents={agents} selectedJobId={selectedJobId} onSelect={handleSelectJob} />
                            </div>
                          )}
                          {lg.verificationJobs.length > 0 && (
                            <div style={{ borderTop: '1px solid var(--border)', paddingTop: 8 }}>
                              <div style={{ fontSize: 10, color: 'var(--text-dim)', marginBottom: 3, paddingLeft: 2, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Verification</div>
                              {lg.verificationJobs.map(j => (
                                <JobRow key={j.id} job={j} agents={agents} selectedJobId={selectedJobId} onSelect={handleSelectJob} />
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
