import React, { useState, useEffect } from 'react';
import type { CreateDebateRequest, Template } from '@shared/types';
import { DEFAULT_DEBATE_CLAUDE_MODEL, DEFAULT_DEBATE_CODEX_MODEL } from '@shared/models';
import { useModels } from '../hooks/useModels';

interface DebateFormProps {
  initial?: Partial<CreateDebateRequest>;
  onSubmit: (req: CreateDebateRequest) => Promise<void>;
  onClose: () => void;
}

export function DebateForm({ initial, onSubmit, onClose }: DebateFormProps) {
  const { claude: claudeModels, codex: codexModels } = useModels();
  const [title, setTitle] = useState(initial?.title ?? '');
  const [task, setTask] = useState(initial?.task ?? '');
  const [claudeModel, setClaudeModel] = useState(initial?.claudeModel ?? DEFAULT_DEBATE_CLAUDE_MODEL);
  const [codexModel, setCodexModel] = useState(initial?.codexModel ?? DEFAULT_DEBATE_CODEX_MODEL);
  const [maxRounds, setMaxRounds] = useState(initial?.maxRounds ?? 3);
  const [workDir, setWorkDir] = useState(initial?.workDir ?? '');
  const [templateId, setTemplateId] = useState(initial?.templateId ?? '');
  const [postActionPrompt, setPostActionPrompt] = useState(initial?.postActionPrompt ?? '');
  const [postActionRole, setPostActionRole] = useState<'claude' | 'codex'>('claude');
  const [postActionVerification, setPostActionVerification] = useState(false);
  const [loopCount, setLoopCount] = useState(initial?.loopCount ?? 1);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetch('/api/templates').then(r => r.json()).then(setTemplates).catch(console.error);
  }, []);

  const handleTemplateChange = (newTemplateId: string) => {
    setTemplateId(newTemplateId);
    const tpl = templates.find(t => t.id === newTemplateId);
    if (tpl?.work_dir) {
      setWorkDir(tpl.work_dir);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!task.trim()) return;
    setLoading(true);
    try {
      await onSubmit({
        title: title.trim() || undefined,
        task: task.trim(),
        claudeModel,
        codexModel,
        maxRounds,
        workDir: workDir.trim() || undefined,
        templateId: templateId || undefined,
        postActionPrompt: postActionPrompt.trim() || undefined,
        postActionRole: postActionPrompt.trim() ? postActionRole : undefined,
        postActionVerification: postActionPrompt.trim() ? postActionVerification : undefined,
        loopCount: loopCount > 1 ? loopCount : undefined,
      });
      onClose();
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>New Debate</h2>
          <button className="btn-icon" onClick={onClose}>&#x2715;</button>
        </div>
        <form onSubmit={handleSubmit} className="job-form">
          <div className="form-group">
            <label htmlFor="debate-title">Title <span className="form-label-hint">(optional)</span></label>
            <input
              id="debate-title"
              type="text"
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="Auto-generated from task if blank"
              autoFocus
            />
          </div>

          {templates.length > 0 && (
            <div className="form-group">
              <label htmlFor="debate-template">Template <span className="form-label-hint">(optional)</span></label>
              <select
                id="debate-template"
                value={templateId}
                onChange={e => handleTemplateChange(e.target.value)}
              >
                <option value="">None</option>
                {templates.map(t => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
            </div>
          )}

          <div className="form-group">
            <label htmlFor="debate-task">Task Description</label>
            <textarea
              id="debate-task"
              value={task}
              onChange={e => setTask(e.target.value)}
              placeholder="Describe the task both sides will analyze and debate..."
              rows={6}
              required
            />
          </div>

          <div className="form-row">
            <div className="form-group">
              <label htmlFor="debate-claude-model">Claude Model</label>
              <select
                id="debate-claude-model"
                value={claudeModel}
                onChange={e => setClaudeModel(e.target.value)}
              >
                {claudeModels.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label htmlFor="debate-codex-model">Codex Model</label>
              <select
                id="debate-codex-model"
                value={codexModel}
                onChange={e => setCodexModel(e.target.value)}
              >
                {codexModels.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
            </div>
          </div>
          <div className="form-group form-group-sm">
            <span className="form-label-hint">Debates default to Opus 4.7 for Claude, which is higher cost than Sonnet.</span>
          </div>

          <div className="form-row">
            <div className="form-group form-group-sm">
              <label htmlFor="debate-max-rounds">Max Rounds</label>
              <input
                id="debate-max-rounds"
                type="number"
                value={maxRounds}
                onChange={e => setMaxRounds(Number(e.target.value))}
                min={1}
                max={10}
              />
            </div>
            <div className="form-group form-group-sm">
              <label htmlFor="debate-loop-count">Loops</label>
              <input
                id="debate-loop-count"
                type="number"
                value={loopCount}
                onChange={e => setLoopCount(Math.max(1, Number(e.target.value)))}
                min={1}
                max={20}
                title="Run the entire debate flow this many times in sequence"
              />
            </div>
            <div className="form-group">
              <label htmlFor="debate-workdir">Working Directory</label>
              <input
                id="debate-workdir"
                type="text"
                value={workDir}
                onChange={e => setWorkDir(e.target.value)}
                placeholder="/path/to/project (optional)"
              />
            </div>
          </div>

          <div className="form-group">
            <label htmlFor="debate-post-action">Post-Debate Action <span className="form-label-hint">(optional — runs after debate concludes)</span></label>
            <textarea
              id="debate-post-action"
              value={postActionPrompt}
              onChange={e => setPostActionPrompt(e.target.value)}
              placeholder="e.g. Implement what you agreed upon"
              rows={3}
            />
          </div>

          {postActionPrompt.trim() && (
            <div className="form-group">
              <label>Run action with</label>
              <div className="radio-group">
                <label className="radio-label">
                  <input type="radio" value="claude" checked={postActionRole === 'claude'} onChange={() => setPostActionRole('claude')} />
                  Claude ({claudeModel})
                </label>
                <label className="radio-label">
                  <input type="radio" value="codex" checked={postActionRole === 'codex'} onChange={() => setPostActionRole('codex')} />
                  Codex ({codexModel})
                </label>
              </div>
            </div>
          )}

          {postActionPrompt.trim() && (
            <div className="form-group">
              <label className="form-checkbox-label">
                <input
                  type="checkbox"
                  checked={postActionVerification}
                  onChange={e => setPostActionVerification(e.target.checked)}
                />
                Verification
                <span className="form-label-hint" style={{ marginLeft: 4 }}>
                  (after action, the other model reviews and the implementer can apply feedback)
                </span>
              </label>
            </div>
          )}

          <div className="form-actions">
            <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={loading}>
              {loading ? 'Starting...' : 'Start Debate'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
