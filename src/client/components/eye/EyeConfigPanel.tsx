import { useState, useEffect } from 'react';
import styles from './EyeConfigPanel.module.css';

interface EyeTarget {
  path: string;
  context: string;
}

const INTERVAL_OPTIONS = [
  { label: '1 minute', ms: 60_000 },
  { label: '5 minutes', ms: 300_000 },
  { label: '10 minutes', ms: 600_000 },
  { label: '15 minutes', ms: 900_000 },
  { label: '30 minutes', ms: 1_800_000 },
  { label: '1 hour', ms: 3_600_000 },
  { label: '2 hours', ms: 7_200_000 },
  { label: '4 hours', ms: 14_400_000 },
];

export function EyeConfigPanel(): JSX.Element {
  const [targets, setTargets] = useState<EyeTarget[]>([]);
  const [linearApiKey, setLinearApiKey] = useState('');
  const [linearConfigured, setLinearConfigured] = useState(false);
  const [scriptsPath, setScriptsPath] = useState('');
  const [repoPath, setRepoPath] = useState('');
  const [prompt, setPrompt] = useState('');
  const [defaultPrompt, setDefaultPrompt] = useState('');
  const [promptExpanded, setPromptExpanded] = useState(false);
  const [repeatIntervalMs, setRepeatIntervalMs] = useState(300_000);
  const [addendum, setAddendum] = useState('');
  const [addendumExpanded, setAddendumExpanded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    fetch('/api/eye/config')
      .then(r => r.json())
      .then(data => {
        setTargets(data.targets ?? []);
        setLinearConfigured(!!(data.linearApiKey));
        setScriptsPath(data.scriptsPath ?? '');
        setRepoPath(data.repoPath ?? '');
        setPrompt(data.prompt ?? '');
        setDefaultPrompt(data.defaultPrompt ?? '');
        setRepeatIntervalMs(data.repeatIntervalMs ?? 300_000);
        setAddendum(data.addendum ?? '');
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const handleAdd = () => {
    setTargets(prev => [...prev, { path: '', context: '' }]);
    setDirty(true);
  };

  const handleRemove = (idx: number) => {
    setTargets(prev => prev.filter((_, i) => i !== idx));
    setDirty(true);
  };

  const handleChange = (idx: number, field: 'path' | 'context', value: string) => {
    setTargets(prev => prev.map((t, i) => i === idx ? { ...t, [field]: value } : t));
    setDirty(true);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const body: Record<string, any> = { targets, scriptsPath, repoPath, prompt, repeatIntervalMs, addendum };
      if (linearApiKey) body.linearApiKey = linearApiKey;
      const res = await fetch('/api/eye/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        const data = await res.json();
        setTargets(data.targets);
        setLinearConfigured(!!(data.linearApiKey));
        setLinearApiKey('');
        setScriptsPath(data.scriptsPath ?? '');
        setRepoPath(data.repoPath ?? '');
        setPrompt(data.prompt ?? '');
        setDefaultPrompt(data.defaultPrompt ?? '');
        setRepeatIntervalMs(data.repeatIntervalMs ?? 300_000);
        setAddendum(data.addendum ?? '');
        setDirty(false);
      }
    } finally {
      setSaving(false);
    }
  };

  const handleResetPrompt = () => {
    setPrompt('');
    setDirty(true);
  };

  if (loading) return <div className="eye-empty">Loading...</div>;

  return (
    <div className={styles.container}>
      {dirty && (
        <div className={styles.stickyBar}>
          <button className="btn btn-primary btn-sm" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving...' : 'Save Configuration'}
          </button>
        </div>
      )}
      <div className={styles.body}>
        {/* Target Directories */}
        <div className={styles.section}>
          <div className={styles.sectionHeaderRow}>
            <div>
              <div className={styles.sectionTitle}>Target Directories</div>
              <div className={styles.sectionDesc}>
                Directories for Eye to investigate. Add context to guide its focus.
              </div>
            </div>
            <button className="btn btn-sm" onClick={handleAdd}>+ Add Target</button>
          </div>

          {targets.length === 0 && (
            <div className="eye-empty" style={{ padding: 24 }}>
              No targets configured. Add directories for Eye to investigate.
            </div>
          )}

          <div className={styles.targetsList}>
            {targets.map((t, i) => (
              <div key={i} className={styles.targetCard}>
                <div className={styles.targetPathRow}>
                  <input
                    type="text"
                    value={t.path}
                    onChange={e => handleChange(i, 'path', e.target.value)}
                    placeholder="/path/to/directory"
                    className={styles.monoInput}
                  />
                  <button
                    className="btn-icon"
                    onClick={() => handleRemove(i)}
                    title="Remove target"
                    style={{ color: 'var(--text-muted)', fontSize: 16 }}
                  >
                    &times;
                  </button>
                </div>
                <textarea
                  value={t.context}
                  onChange={e => handleChange(i, 'context', e.target.value)}
                  placeholder="Context: what to look for, known issues, tech stack, priorities..."
                  rows={2}
                  className={styles.contextTextarea}
                />
              </div>
            ))}
          </div>
        </div>

        {/* Cycle Frequency */}
        <div className={styles.section}>
          <div className={styles.sectionTitle} style={{ marginBottom: 4 }}>Cycle Frequency</div>
          <div className={styles.sectionDesc} style={{ marginBottom: 8 }}>
            How often Eye runs between cycles. Takes effect immediately if Eye is running.
          </div>
          <select
            value={repeatIntervalMs}
            onChange={e => { setRepeatIntervalMs(Number(e.target.value)); setDirty(true); }}
            className={styles.intervalSelect}
          >
            {INTERVAL_OPTIONS.map(opt => (
              <option key={opt.ms} value={opt.ms}>{opt.label}</option>
            ))}
            {!INTERVAL_OPTIONS.some(o => o.ms === repeatIntervalMs) && (
              <option value={repeatIntervalMs}>{Math.round(repeatIntervalMs / 60_000)}m (custom)</option>
            )}
          </select>
        </div>

        {/* System Prompt */}
        <div className={styles.section}>
          <div className={styles.sectionHeaderRowSmall}>
            <div>
              <div className={styles.sectionTitle}>System Prompt</div>
              <div className={styles.sectionDesc}>
                The instructions Eye follows each cycle. Leave blank to use the default.
              </div>
            </div>
            <div className={styles.headerBtns}>
              {prompt && (
                <button className="btn btn-sm" onClick={handleResetPrompt} title="Revert to default prompt">
                  Reset to default
                </button>
              )}
              <button className="btn btn-sm" onClick={() => setPromptExpanded(e => !e)}>
                {promptExpanded ? 'Collapse' : (prompt ? 'Edit' : 'Customize')}
              </button>
            </div>
          </div>
          {promptExpanded && (
            <textarea
              value={prompt || defaultPrompt}
              onChange={e => { setPrompt(e.target.value === defaultPrompt ? '' : e.target.value); setDirty(true); }}
              rows={20}
              className={styles.expandableTextarea}
            />
          )}
          {!promptExpanded && prompt && (
            <div className={styles.previewBox}>
              Custom prompt active ({prompt.length} chars)
            </div>
          )}
        </div>

        {/* Addendum */}
        <div className={styles.section}>
          <div className={styles.sectionHeaderRowSmall}>
            <div>
              <div className={styles.sectionTitle}>Addendum</div>
              <div className={styles.sectionDesc}>
                Eye's accumulated notes — appended to each cycle's prompt. Eye updates this automatically; you can also edit it directly.
              </div>
            </div>
            <button className="btn btn-sm" onClick={() => setAddendumExpanded(e => !e)}>
              {addendumExpanded ? 'Collapse' : (addendum ? 'Edit' : 'View')}
            </button>
          </div>
          {addendumExpanded ? (
            <textarea
              value={addendum}
              onChange={e => { setAddendum(e.target.value); setDirty(true); }}
              rows={20}
              className={styles.expandableTextarea}
            />
          ) : addendum ? (
            <div className={styles.previewBox}>
              {addendum.length} chars · {addendum.split('\n').length} lines
            </div>
          ) : (
            <div className="eye-empty" style={{ padding: 16 }}>No addendum yet. Eye will populate this as it learns.</div>
          )}
        </div>

        {/* Integrations */}
        <div className={styles.section}>
          <div className={styles.sectionTitle} style={{ marginBottom: 8 }}>Integrations</div>
          <div className={styles.integrationList}>
            <div className={styles.integrationCard}>
              <div className={styles.integrationLabel}>
                Scripts Path
                <span className={styles.integrationLabelSuffix}>(for query_logs and query_db)</span>
              </div>
              <input
                type="text"
                value={scriptsPath}
                onChange={e => { setScriptsPath(e.target.value); setDirty(true); }}
                placeholder="/path/to/your/scripts"
                className={styles.monoInputFull}
              />
              <div className={styles.integrationHint}>
                Path to a repo containing opensearch-curl.py and rds.sh scripts. Used by query_logs and query_db tools.
                Requires <code className={styles.inlineCode}>aws sso login</code> for auth.
              </div>
            </div>

            <div className={styles.integrationCard}>
              <div className={styles.integrationLabel}>
                Repo Path
                <span className={styles.integrationLabelSuffix}>(for query_ci_logs)</span>
              </div>
              <input
                type="text"
                value={repoPath}
                onChange={e => { setRepoPath(e.target.value); setDirty(true); }}
                placeholder="/path/to/your/repo"
                className={styles.monoInputFull}
              />
              <div className={styles.integrationHint}>
                Default git repo path for the query_ci_logs tool (used to run gh commands).
              </div>
            </div>

            <div className={styles.integrationCard}>
              <div className={styles.integrationLabel}>
                Linear API Key
                {linearConfigured && <span className={styles.configuredBadge}>Configured</span>}
              </div>
              <input
                type="password"
                value={linearApiKey}
                onChange={e => { setLinearApiKey(e.target.value); setDirty(true); }}
                placeholder={linearConfigured ? 'Enter new key to replace...' : 'lin_api_...'}
                className={styles.passwordInput}
              />
              <div className={styles.integrationHint}>
                Personal API key from Linear Settings &gt; API. Used by query_linear tool.
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
