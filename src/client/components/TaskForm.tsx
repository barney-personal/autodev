import React, { useState, useEffect, useMemo } from 'react';
import type { CreateTaskRequest, TaskPreset, Template, RetryPolicy, Job } from '@shared/types';
import { TemplateModelStats } from './TemplateModelStats';
import { StopModePicker } from './StopModePicker';
import { useModels } from '../hooks/useModels';
import { useTaskFormState } from '../hooks/useTaskFormState';

interface TaskFormProps {
  onSubmit: (req: CreateTaskRequest) => Promise<void>;
  onClose: () => void;
  availableJobs?: Job[];
}

const PRESET_LABELS: Record<TaskPreset, string> = {
  quick: 'Quick',
  reviewed: 'Reviewed',
  autonomous: 'Autonomous',
};

const PRESET_DESCRIPTIONS: Record<TaskPreset, string> = {
  quick: 'Single-pass job, no review',
  reviewed: 'Single-pass job with review',
  autonomous: 'Multi-cycle assess/review/implement',
};

export function TaskForm({ onSubmit, onClose, availableJobs = [] }: TaskFormProps) {
  const { claude: claudeModels, codex: codexModels } = useModels();
  const form = useTaskFormState();
  const { state, config, set, applyPreset, setIterations, toggleDepend, toggleReviewModel } = form;
  const routesTo = config.routesTo;

  // ── UI-only state (not part of the submitted request) ─────────────────────
  const [templates, setTemplates] = useState<Template[]>([]);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pendingJobs = availableJobs.filter(
    j => j.status === 'queued' || j.status === 'assigned' || j.status === 'running'
  );

  useEffect(() => {
    fetch('/api/templates').then(r => r.json()).then(setTemplates).catch(console.error);
  }, []);

  const selectedTemplate = useMemo(
    () => templates.find(t => t.id === state.templateId) ?? null,
    [templates, state.templateId],
  );

  const handleTemplateChange = (newTemplateId: string) => {
    const tpl = templates.find(t => t.id === newTemplateId);
    set({
      templateId: newTemplateId,
      ...(tpl?.work_dir ? { workDir: tpl.work_dir } : {}),
      ...(tpl?.model ? { model: tpl.model } : {}),
    });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!state.description.trim() && !state.templateId) return;
    setLoading(true);
    setError(null);

    try {
      await onSubmit(form.buildRequest());
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create task');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>New Task</h2>
          <button className="btn-icon" onClick={onClose}>&#x2715;</button>
        </div>
        <form onSubmit={handleSubmit} className="job-form">
          {/* ── Preset strip ─────────────────────────────────────────── */}
          <div className="form-group">
            <label>Preset</label>
            <div className="stop-mode-buttons">
              {(['quick', 'reviewed', 'autonomous'] as TaskPreset[]).map(p => (
                <button
                  key={p}
                  type="button"
                  className={`stop-mode-btn${state.preset === p ? ' active' : ''}`}
                  onClick={() => applyPreset(p)}
                  title={PRESET_DESCRIPTIONS[p]}
                >
                  {PRESET_LABELS[p]}
                </button>
              ))}
            </div>
            <span className="form-label-hint" style={{ marginTop: 4, display: 'block' }}>
              {PRESET_DESCRIPTIONS[state.preset]} {routesTo === 'workflow' ? '(workflow)' : '(job)'}
            </span>
          </div>

          {/* ── Title ────────────────────────────────────────────────── */}
          <div className="form-group">
            <label htmlFor="task-title">Title <span className="form-label-hint">(optional, auto-generated if blank)</span></label>
            <input
              id="task-title"
              type="text"
              value={state.title}
              onChange={e => set({ title: e.target.value })}
              placeholder="Leave blank to auto-generate from description"
              autoFocus
            />
          </div>

          {/* ── Template ─────────────────────────────────────────────── */}
          <div className="form-group">
            <label htmlFor="task-template">Template <span className="form-label-hint">(optional)</span></label>
            <select id="task-template" value={state.templateId} onChange={e => handleTemplateChange(e.target.value)}>
              <option value="">None</option>
              {templates.map(t => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
            {selectedTemplate && (
              <div className="template-preview">
                {selectedTemplate.content.slice(0, 200)}
                {selectedTemplate.content.length > 200 ? '...' : ''}
              </div>
            )}
          </div>

          {/* ── Description ──────────────────────────────────────────── */}
          <div className="form-group">
            <label htmlFor="task-description">
              Task Description
              {state.templateId && routesTo === 'job' && <span className="form-label-hint"> (optional when template is provided)</span>}
              {routesTo === 'workflow' && <span className="form-label-hint"> (required for autonomous tasks)</span>}
            </label>
            <textarea
              id="task-description"
              value={state.description}
              onChange={e => set({ description: e.target.value })}
              placeholder={
                routesTo === 'workflow'
                  ? 'Describe what the agents should accomplish across multiple cycles...'
                  : state.templateId
                    ? 'Additional instructions (optional)...'
                    : 'Detailed instructions for the agent...'
              }
              rows={5}
              required={routesTo === 'workflow' || !state.templateId}
            />
          </div>

          {/* ── Working directory + model ─────────────────────────────── */}
          <div className="form-group">
            <label htmlFor="task-workdir">Working Directory</label>
            <input
              id="task-workdir"
              type="text"
              value={state.workDir}
              onChange={e => set({ workDir: e.target.value })}
              placeholder="/path/to/project (optional)"
            />
          </div>

          <div className="form-row">
            <div className="form-group">
              <label htmlFor="task-model">
                {routesTo === 'workflow' ? 'Implementer Model' : 'Model'}
                <span className="form-label-hint"> (leave blank to auto-select)</span>
              </label>
              <select id="task-model" value={state.model} onChange={e => set({ model: e.target.value })}>
                <option value="">{routesTo === 'workflow' ? 'Default (Opus 4.7)' : 'Auto-select (Haiku classifies)'}</option>
                {claudeModels.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
                {routesTo === 'job' && codexModels.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
            </div>
            {state.review && (
              <div className="form-group">
                <label htmlFor="task-reviewer">Reviewer Model</label>
                <select id="task-reviewer" value={state.reviewerModel} onChange={e => set({ reviewerModel: e.target.value })}>
                  {codexModels.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
                  {claudeModels.map(m => <option key={`c-${m.value}`} value={m.value}>{m.label}</option>)}
                </select>
              </div>
            )}
          </div>

          <TemplateModelStats templateId={state.templateId} model={state.model} />

          {/* ── Review toggle ────────────────────────────────────────── */}
          <div className="form-group">
            <label className="form-checkbox-label">
              <input
                type="checkbox"
                checked={state.review}
                onChange={e => set({ review: e.target.checked })}
                disabled={routesTo === 'workflow'}
              />
              Review on completion
              {routesTo === 'workflow' && <span className="form-label-hint"> (always on for workflows)</span>}
            </label>
          </div>

          {/* ── Iterations + worktree ────────────────────────────────── */}
          <div className="form-row">
            <div className="form-group">
              <label htmlFor="task-iterations">
                Iterations
                <span className="tooltip-icon" data-tip="1 = single-pass job. >1 = multi-cycle autonomous workflow with assess/review/implement phases.">?</span>
              </label>
              <input
                id="task-iterations"
                type="number"
                min={1}
                max={50}
                value={state.iterations}
                onChange={e => setIterations(parseInt(e.target.value, 10))}
              />
            </div>
            <div className="form-group">
              <label className="form-checkbox-label" style={{ marginTop: 22 }}>
                <input
                  type="checkbox"
                  checked={state.useWorktree}
                  onChange={e => set({ useWorktree: e.target.checked })}
                />
                Use worktree
                <span className="tooltip-icon" data-tip="Creates a git worktree so the agent works in an isolated checkout on a new branch">?</span>
              </label>
            </div>
          </div>

          {/* ── Job-only: review config (when review enabled on job route) */}
          {routesTo === 'job' && state.review && (
            <div className="form-group" style={{ paddingLeft: 20 }}>
              <label>Review Models</label>
              <div className="completion-checks-list">
                {[
                  { value: 'claude-haiku-4-5-20251001', label: 'Haiku' },
                  { value: 'claude-sonnet-4-6[1m]', label: 'Sonnet' },
                  { value: 'claude-opus-4-7[1m]', label: 'Opus 4.7' },
                  { value: 'claude-opus-4-8[1m]', label: 'Opus 4.8' },
                ].map(m => (
                  <label key={m.value} className="form-checkbox-label">
                    <input
                      type="checkbox"
                      checked={state.reviewModels.includes(m.value)}
                      onChange={() => toggleReviewModel(m.value)}
                    />
                    {m.label}
                  </label>
                ))}
              </div>
              <label className="form-checkbox-label" style={{ marginTop: 8 }}>
                <input
                  type="checkbox"
                  checked={state.reviewAuto}
                  onChange={e => set({ reviewAuto: e.target.checked })}
                />
                Auto-trigger reviews
              </label>
            </div>
          )}

          {/* ── Job-only advanced section ─────────────────────────────── */}
          {routesTo === 'job' && (
            <>
              <button
                type="button"
                className="btn btn-ghost"
                style={{ fontSize: 12, padding: '4px 0', marginBottom: 8 }}
                onClick={() => setShowAdvanced(v => !v)}
              >
                {showAdvanced ? '\u25be' : '\u25b8'} Advanced settings
              </button>

              {showAdvanced && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <div className="form-group form-group-sm">
                    <label htmlFor="task-priority">
                      Priority
                      <span className="tooltip-icon" data-tip="Controls dispatch order when multiple jobs are waiting. Higher = started sooner (range: -10 to 10).">?</span>
                    </label>
                    <input
                      id="task-priority"
                      type="number"
                      value={state.priority}
                      onChange={e => set({ priority: Number(e.target.value) })}
                      min={-10}
                      max={10}
                    />
                  </div>

                  {pendingJobs.length > 0 && (
                    <div className="form-group">
                      <label>
                        Depends On <span className="form-label-hint">(job won't start until selected jobs finish)</span>
                      </label>
                      <div className="depends-on-list">
                        {pendingJobs.map(j => (
                          <label key={j.id} className="depends-on-item">
                            <input
                              type="checkbox"
                              checked={state.dependsOn.includes(j.id)}
                              onChange={() => toggleDepend(j.id)}
                            />
                            <span className={`depends-on-status status-${j.status}`}>{j.status}</span>
                            <span className="depends-on-title">{j.title}</span>
                          </label>
                        ))}
                      </div>
                    </div>
                  )}

                  <div className="form-group">
                    <label className="form-checkbox-label">
                      <input
                        type="checkbox"
                        checked={state.interactive}
                        onChange={e => set({ interactive: e.target.checked })}
                      />
                      Interactive session
                      <span className="tooltip-icon" data-tip="Keeps terminal open for direct conversation">?</span>
                    </label>
                  </div>

                  <StopModePicker
                    label="Stopping condition"
                    mode={state.stopMode}
                    value={state.stopValue}
                    onModeChange={mode => set({ stopMode: mode })}
                    onValueChange={value => set({ stopValue: value })}
                  />

                  <div className="form-group">
                    <label htmlFor="task-repeat">
                      Repeat every
                      <span className="tooltip-icon" data-tip="After the job completes, automatically re-queue it after this many seconds. Leave blank for no repeat.">?</span>
                    </label>
                    <div className="repeat-input-row">
                      <input
                        id="task-repeat"
                        type="number"
                        value={state.repeatSeconds}
                        onChange={e => set({ repeatSeconds: e.target.value === '' ? '' : Number(e.target.value) })}
                        placeholder="no repeat"
                        min={1}
                      />
                      <span className="repeat-unit">seconds</span>
                    </div>
                  </div>

                  <div className="form-row">
                    <div className="form-group">
                      <label htmlFor="task-retry">
                        On Failure
                        <span className="tooltip-icon" data-tip="What to do when the agent fails. 'Retry same' re-queues the identical task. 'Analyze & retry' spawns a lightweight agent to diagnose the failure and create a refined retry.">?</span>
                      </label>
                      <select
                        id="task-retry"
                        value={state.retryPolicy}
                        onChange={e => set({ retryPolicy: e.target.value as RetryPolicy })}
                      >
                        <option value="none">No retry</option>
                        <option value="same">Retry same</option>
                        <option value="analyze">Analyze & retry</option>
                      </select>
                    </div>
                    {state.retryPolicy !== 'none' && (
                      <div className="form-group form-group-sm">
                        <label htmlFor="task-max-retries">Max Retries</label>
                        <input
                          id="task-max-retries"
                          type="number"
                          value={state.maxRetries}
                          onChange={e => set({ maxRetries: Number(e.target.value) })}
                          min={1}
                          max={10}
                        />
                      </div>
                    )}
                  </div>

                  <div className="form-group">
                    <label>
                      Completion Checks
                      <span className="tooltip-icon" data-tip="Validate agent output before accepting 'done'. Failed checks convert the job to 'failed' and can trigger retry.">?</span>
                    </label>
                    <div className="completion-checks-list">
                      <label className="form-checkbox-label">
                        <input
                          type="checkbox"
                          checked={state.checkDiffNotEmpty}
                          onChange={e => set({ checkDiffNotEmpty: e.target.checked })}
                        />
                        Diff not empty
                      </label>
                      <label className="form-checkbox-label">
                        <input
                          type="checkbox"
                          checked={state.checkNoErrors}
                          onChange={e => set({ checkNoErrors: e.target.checked })}
                        />
                        No errors in output
                      </label>
                    </div>
                    <input
                      type="text"
                      value={state.customCheckCmd}
                      onChange={e => set({ customCheckCmd: e.target.value })}
                      placeholder="Custom check command (exit 0 = pass)"
                      style={{ marginTop: 6 }}
                    />
                  </div>

                  <div className="form-group">
                    <label className="form-checkbox-label">
                      <input
                        type="checkbox"
                        checked={state.debateEnabled}
                        onChange={e => set({ debateEnabled: e.target.checked })}
                      />
                      Debate before start
                      <span className="tooltip-icon" data-tip="Two models argue about the best approach before the job starts. The debate outcome enriches the job description.">?</span>
                    </label>
                  </div>

                  {state.debateEnabled && (
                    <div className="form-group" style={{ paddingLeft: 20 }}>
                      <div className="form-row">
                        <div className="form-group">
                          <label htmlFor="task-debate-claude">Claude Model</label>
                          <select id="task-debate-claude" value={state.debateClaudeModel} onChange={e => set({ debateClaudeModel: e.target.value })}>
                            <option value="claude-opus-4-8[1m]">claude-opus-4-8[1m] — default, most capable</option>
                            <option value="claude-opus-4-7[1m]">claude-opus-4-7[1m]</option>
                            <option value="claude-opus-4-6[1m]">claude-opus-4-6[1m]</option>
                            <option value="claude-sonnet-4-6[1m]">claude-sonnet-4-6[1m]</option>
                            <option value="claude-haiku-4-5-20251001">claude-haiku-4-5</option>
                          </select>
                        </div>
                        <div className="form-group">
                          <label htmlFor="task-debate-codex">Codex Model</label>
                          <select id="task-debate-codex" value={state.debateCodexModel} onChange={e => set({ debateCodexModel: e.target.value })}>
                            {codexModels.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
                          </select>
                        </div>
                      </div>
                      <div className="form-group form-group-sm">
                        <span className="form-label-hint">Default debate Claude model is Opus 4.7, which costs more than Sonnet.</span>
                      </div>
                      <div className="form-group form-group-sm">
                        <label htmlFor="task-debate-rounds">Max Rounds</label>
                        <input
                          id="task-debate-rounds"
                          type="number"
                          value={state.debateMaxRounds}
                          onChange={e => set({ debateMaxRounds: Number(e.target.value) })}
                          min={1}
                          max={10}
                        />
                      </div>
                    </div>
                  )}
                </div>
              )}
            </>
          )}

          {/* ── Workflow-only advanced section ─────────────────────────── */}
          {routesTo === 'workflow' && (
            <>
              <button
                type="button"
                className="btn btn-ghost"
                style={{ fontSize: 12, padding: '4px 0', marginBottom: 8 }}
                onClick={() => setShowAdvanced(v => !v)}
              >
                {showAdvanced ? '\u25be' : '\u25b8'} Workflow verification
              </button>

              {showAdvanced && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <div className="form-group">
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={state.verifyEnabled}
                        onChange={e => set({ verifyEnabled: e.target.checked })}
                      />
                      Verify before PR
                    </label>
                    {state.verifyEnabled && (
                      <>
                        <input
                          id="task-start-cmd"
                          type="text"
                          value={state.startCommand}
                          onChange={e => set({ startCommand: e.target.value })}
                          placeholder="e.g. npm run dev, docker compose up"
                          style={{ fontFamily: 'var(--font-mono)', fontSize: 12, marginTop: 4 }}
                        />
                        <div style={{ fontSize: 11, color: '#666', marginTop: 4 }}>
                          Command to start the app. A QA agent will write and run smoke tests against it.
                        </div>
                      </>
                    )}
                  </div>
                </div>
              )}
            </>
          )}

          {error && <div className="form-error">{error}</div>}

          <div className="form-actions">
            <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={loading}>
              {loading
                ? 'Creating...'
                : routesTo === 'workflow'
                  ? 'Start Autonomous Run'
                  : 'Create Job'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
