import React, { useState, useEffect } from 'react';
import type { CreateAutonomousAgentRunRequest, Template, StopMode } from '@shared/types';
import { useModels } from '../hooks/useModels';
import { StopModePicker } from './StopModePicker';

interface WorkflowFormProps {
  onSubmit: (req: CreateAutonomousAgentRunRequest) => Promise<void>;
  onClose: () => void;
}

export function WorkflowForm({ onSubmit, onClose }: WorkflowFormProps) {
  const { claude: claudeModels, codex: codexModels } = useModels();
  const [title, setTitle] = useState('');
  const [task, setTask] = useState('');
  const [workDir, setWorkDir] = useState('');
  const [implementerModel, setImplementerModel] = useState('claude-sonnet-4-6[1m]');
  const [reviewerModel, setReviewerModel] = useState('codex');
  const [maxCycles, setMaxCycles] = useState(10);
  const [templateId, setTemplateId] = useState('');
  const [useWorktree, setUseWorktree] = useState(true);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [stopModeAssess, setStopModeAssess] = useState<StopMode>('turns');
  const [stopValueAssess, setStopValueAssess] = useState<number | null>(50);
  const [stopModeReview, setStopModeReview] = useState<StopMode>('turns');
  const [stopValueReview, setStopValueReview] = useState<number | null>(30);
  const [stopModeImplement, setStopModeImplement] = useState<StopMode>('turns');
  const [stopValueImplement, setStopValueImplement] = useState<number | null>(100);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    fetch('/api/templates').then(r => r.json()).then(setTemplates).catch(console.error);
  }, []);

  const handleTemplateChange = (newTemplateId: string) => {
    setTemplateId(newTemplateId);
    const tpl = templates.find(t => t.id === newTemplateId);
    if (tpl?.work_dir) setWorkDir(tpl.work_dir);
    if (tpl?.model) setImplementerModel(tpl.model);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!task.trim()) return;
    setLoading(true);
    setError('');
    try {
      await onSubmit({
        title: title.trim() || undefined,
        task: task.trim(),
        workDir: workDir.trim() || undefined,
        implementerModel,
        reviewerModel,
        maxCycles,
        templateId: templateId || undefined,
        useWorktree,
        stopModeAssess,
        stopValueAssess: stopValueAssess ?? undefined,
        stopModeReview,
        stopValueReview: stopValueReview ?? undefined,
        stopModeImplement,
        stopValueImplement: stopValueImplement ?? undefined,
      });
      onClose();
    } catch (err: any) {
      setError(err.message ?? 'Failed to create autonomous agent run');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>New Autonomous Agent Run</h2>
          <button className="btn-icon" onClick={onClose}>&#x2715;</button>
        </div>
        <form onSubmit={handleSubmit} className="job-form">
          <div className="form-group">
            <label htmlFor="wf-title">Title <span className="form-label-hint">(optional)</span></label>
            <input
              id="wf-title"
              type="text"
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="Auto-generated from task if blank"
              autoFocus
            />
          </div>

          <div className="form-group">
            <label htmlFor="wf-task">Task <span className="form-label-hint">(required)</span></label>
            <textarea
              id="wf-task"
              value={task}
              onChange={e => setTask(e.target.value)}
              placeholder="Describe what the agents should accomplish across multiple cycles..."
              rows={5}
              required
            />
          </div>

          <div className="form-group">
            <label htmlFor="wf-workdir">Working Directory</label>
            <input
              id="wf-workdir"
              type="text"
              value={workDir}
              onChange={e => setWorkDir(e.target.value)}
              placeholder="/path/to/repo"
            />
          </div>

          <div className="form-row">
            <div className="form-group">
              <label htmlFor="wf-implementer">Implementer Model</label>
              <select id="wf-implementer" value={implementerModel} onChange={e => setImplementerModel(e.target.value)}>
                {claudeModels.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label htmlFor="wf-reviewer">Reviewer Model</label>
              <select id="wf-reviewer" value={reviewerModel} onChange={e => setReviewerModel(e.target.value)}>
                {codexModels.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
                {claudeModels.map(m => <option key={`c-${m.value}`} value={m.value}>{m.label}</option>)}
              </select>
            </div>
          </div>

          <div className="form-row">
            <div className="form-group">
              <label htmlFor="wf-maxcycles">Max Cycles</label>
              <input
                id="wf-maxcycles"
                type="number"
                min={1}
                max={50}
                value={maxCycles}
                onChange={e => {
                  const v = parseInt(e.target.value, 10);
                  setMaxCycles(Number.isNaN(v) || v < 1 ? 10 : v);
                }}
              />
            </div>
            <div className="form-group">
              <label htmlFor="wf-template">Template <span className="form-label-hint">(optional)</span></label>
              <select id="wf-template" value={templateId} onChange={e => handleTemplateChange(e.target.value)}>
                <option value="">No template</option>
                {templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
          </div>

          <div className="form-group">
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={useWorktree}
                onChange={e => setUseWorktree(e.target.checked)}
              />
              Use git worktree (recommended — all phases share one branch, changes accumulate linearly)
            </label>
          </div>

          <button
            type="button"
            className="btn btn-ghost"
            style={{ fontSize: 12, padding: '4px 0', marginBottom: 8 }}
            onClick={() => setShowAdvanced(v => !v)}
          >
            {showAdvanced ? '▾' : '▸'} Advanced settings
          </button>

          {showAdvanced && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <StopModePicker
                label="Assess stopping condition"
                mode={stopModeAssess}
                value={stopValueAssess}
                onModeChange={setStopModeAssess}
                onValueChange={setStopValueAssess}
              />
              <StopModePicker
                label="Review stopping condition"
                mode={stopModeReview}
                value={stopValueReview}
                onModeChange={setStopModeReview}
                onValueChange={setStopValueReview}
              />
              <StopModePicker
                label="Implement stopping condition"
                mode={stopModeImplement}
                value={stopValueImplement}
                onModeChange={setStopModeImplement}
                onValueChange={setStopValueImplement}
              />
            </div>
          )}

          {error && <div className="form-error">{error}</div>}

          <div className="form-actions">
            <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={loading || !task.trim()}>
              {loading ? 'Starting...' : 'Start Run'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
