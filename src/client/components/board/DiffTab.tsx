import type { Workflow } from '@shared/types';

export function DiffTab({ workflow }: { workflow: Workflow }) {
  return (
    <div className="cr-tab-body">
      <div className="diffcard">
        <div style={{ display: 'flex', gap: 14, fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--ink-2)' }}>
          <span style={{ color: 'var(--ink-3)' }}>branch <b style={{ color: 'var(--ink-2)' }}>{workflow.worktree_branch ?? '—'}</b></span>
          {workflow.pr_url && (
            <a
              href={workflow.pr_url}
              target="_blank"
              rel="noopener noreferrer"
              style={{ marginLeft: 'auto', color: 'var(--active)', textDecoration: 'none', fontWeight: 600 }}
            >
              Open PR ↗
            </a>
          )}
        </div>
        <div style={{ color: 'var(--ink-3)', fontSize: 13, padding: '8px 0', textAlign: 'center' }}>
          Diff & file list aren't wired yet for this workflow. Open the PR for the full review.
        </div>
      </div>
    </div>
  );
}
