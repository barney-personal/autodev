import { useState, useEffect } from 'react';
import { DiscussionThread } from './DiscussionThread';
import type { Proposal } from '@shared/types';

interface ProposalMessage {
  role: 'eye' | 'user';
  content: string;
  created_at: number;
}

interface ProposalCardProps {
  proposal: Proposal;
  messages: ProposalMessage[];
  hasUnread?: boolean;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  onRetry: (id: string) => void;
  onSendMessage: (id: string, content: string) => void;
}

const CATEGORY_COLORS: Record<string, string> = {
  bug_fix: '#f85149',
  security: '#f85149',
  performance: '#f59e0b',
  tech_debt: '#a78bfa',
  product_improvement: '#58a6ff',
};

const CATEGORY_LABELS: Record<string, string> = {
  bug_fix: 'Bug Fix',
  security: 'Security',
  performance: 'Performance',
  tech_debt: 'Tech Debt',
  product_improvement: 'Product',
};

const COMPLEXITY_COLORS: Record<string, string> = {
  trivial: '#22c55e',
  small: '#58a6ff',
  medium: '#f59e0b',
  large: '#f85149',
};

const STATUS_LABELS: Record<string, string> = {
  pending: 'Pending',
  approved: 'Approved',
  rejected: 'Rejected',
  discussing: 'Discussing',
  in_progress: 'In Progress',
  done: 'Done',
  failed: 'Failed',
};

const STATUS_COLORS: Record<string, string> = {
  pending: '#f59e0b',
  approved: '#22c55e',
  rejected: '#6b7280',
  discussing: '#58a6ff',
  in_progress: '#f59e0b',
  done: '#22c55e',
  failed: '#f85149',
};

function ExecutionJobBadge({ jobId }: { jobId: string }) {
  const [jobStatus, setJobStatus] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/jobs/${jobId}`)
      .then(r => r.ok ? r.json() : null)
      .then(j => j && setJobStatus(j.status))
      .catch(() => {});
  }, [jobId]);

  const color = jobStatus === 'done' ? '#22c55e' : jobStatus === 'failed' ? '#f85149' : '#f59e0b';
  const label = jobStatus === 'done' ? 'Done' : jobStatus === 'failed' ? 'Failed' : jobStatus === 'cancelled' ? 'Cancelled' : 'Working...';

  return (
    <a
      href={`#job-${jobId}`}
      style={{ fontSize: 11, color, textDecoration: 'none', border: `1px solid ${color}`, borderRadius: 4, padding: '1px 6px', flexShrink: 0 }}
      title={`Execution job: ${jobId}`}
    >
      {label}
    </a>
  );
}

export function ProposalCard({ proposal, messages, hasUnread, onApprove, onReject, onRetry, onSendMessage }: ProposalCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [showThread, setShowThread] = useState(false);

  const confidenceColor = proposal.confidence >= 0.8 ? '#22c55e' : proposal.confidence >= 0.5 ? '#f59e0b' : '#f85149';
  const confidencePct = Math.round(proposal.confidence * 100);
  const isActionable = proposal.status === 'pending' || proposal.status === 'discussing';
  const isFailed = proposal.status === 'failed';
  const canMessage = isActionable || proposal.status === 'approved' || proposal.status === 'in_progress' || isFailed;

  return (
    <div className={`eye-proposal ${expanded ? 'eye-proposal-expanded' : ''}`}>
      <div className="eye-proposal-header" onClick={() => setExpanded(!expanded)}>
        <div className="eye-proposal-title-row">
          <span className="eye-proposal-title">{proposal.title}</span>
          {hasUnread && <span className="eye-disc-needs-reply" title="Needs your action" />}
          <span className="eye-proposal-status" style={{ color: STATUS_COLORS[proposal.status] }}>
            {STATUS_LABELS[proposal.status]}
          </span>
        </div>
        <div className="eye-proposal-meta">
          <span className="eye-proposal-badge" style={{ borderColor: CATEGORY_COLORS[proposal.category] ?? '#6b7280', color: CATEGORY_COLORS[proposal.category] ?? '#6b7280' }}>
            {CATEGORY_LABELS[proposal.category] ?? proposal.category}
          </span>
          <span className="eye-proposal-badge" style={{ borderColor: COMPLEXITY_COLORS[proposal.estimated_complexity] ?? '#6b7280', color: COMPLEXITY_COLORS[proposal.estimated_complexity] ?? '#6b7280' }}>
            {proposal.estimated_complexity}
          </span>
          <div className="eye-confidence" title={`${confidencePct}% confidence`}>
            <div className="eye-confidence-bar">
              <div className="eye-confidence-fill" style={{ width: `${confidencePct}%`, background: confidenceColor }} />
            </div>
            <span className="eye-confidence-label" style={{ color: confidenceColor }}>{confidencePct}%</span>
          </div>
          {proposal.codex_confirmed != null && (
            <span
              title={proposal.codex_confirmed
                ? `Codex confirmed (${Math.round((proposal.codex_confidence ?? 0) * 100)}%): ${proposal.codex_reasoning ?? ''}`
                : `Codex did not confirm (${Math.round((proposal.codex_confidence ?? 0) * 100)}%): ${proposal.codex_reasoning ?? ''}`}
              style={{ fontSize: 13, color: proposal.codex_confirmed ? '#22c55e' : '#f59e0b', flexShrink: 0 }}
            >
              {proposal.codex_confirmed ? '✓ Codex' : '? Codex'}
            </span>
          )}
          {proposal.execution_job_id && <ExecutionJobBadge jobId={proposal.execution_job_id} />}
          {messages.length > 0 && (
            <span className="eye-proposal-msg-count" title={`${messages.length} messages`}>
              {messages.length} msg{messages.length !== 1 ? 's' : ''}
            </span>
          )}
        </div>
      </div>

      {expanded && (
        <div className="eye-proposal-body">
          <div className="eye-proposal-section">
            <div className="eye-proposal-label">Summary</div>
            <div className="eye-proposal-text">{proposal.summary}</div>
          </div>
          <div className="eye-proposal-section">
            <div className="eye-proposal-label">Rationale</div>
            <div className="eye-proposal-text">{proposal.rationale}</div>
          </div>
          {proposal.evidence && (
            <div className="eye-proposal-section">
              <div className="eye-proposal-label">Evidence</div>
              <div className="eye-proposal-text eye-proposal-evidence">{proposal.evidence}</div>
            </div>
          )}
          {proposal.implementation_plan && (
            <div className="eye-proposal-section">
              <div className="eye-proposal-label">Implementation Plan</div>
              <div className="eye-proposal-text eye-proposal-evidence">{proposal.implementation_plan}</div>
            </div>
          )}

          <div className="eye-proposal-actions">
            {isActionable && <>
              <button className="btn btn-sm eye-btn-approve" onClick={() => onApprove(proposal.id)}>
                Approve
              </button>
              <button className="btn btn-sm eye-btn-reject" onClick={() => onReject(proposal.id)}>
                Reject
              </button>
            </>}
            {isFailed && <>
              <button className="btn btn-sm eye-btn-approve" onClick={() => onRetry(proposal.id)}>
                Retry
              </button>
              <button className="btn btn-sm eye-btn-reject" onClick={() => onReject(proposal.id)}>
                Cancel
              </button>
            </>}
            {canMessage && (
              <button className="btn btn-sm" onClick={() => setShowThread(!showThread)}>
                {showThread ? 'Hide Chat' : 'Discuss'}
              </button>
            )}
          </div>

          {(showThread || messages.length > 0) && (
            <DiscussionThread
              messages={messages}
              onSendMessage={(content) => onSendMessage(proposal.id, content)}
              status={canMessage ? 'open' : 'resolved'}
            />
          )}
        </div>
      )}
    </div>
  );
}
