import { useState, useEffect, useCallback } from 'react';
import { ProposalCard } from '../ProposalCard';
import socket from '../../socket';
import type { Proposal, ProposalMessage } from '@shared/types';

// ─── Proposal List ────────────────────────────────────────────────────────────

interface ProposalListProps {
  proposals: Proposal[];
}

export function ProposalList({ proposals }: ProposalListProps): JSX.Element {
  const [propMessages, setPropMessages] = useState<Record<string, ProposalMessage[]>>({});
  const [propFilter, setPropFilter] = useState<'needs-action' | 'active' | 'done' | 'all'>('needs-action');

  const fetchPropMessages = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/eye/proposals/${id}/messages`);
      const msgs = await res.json();
      setPropMessages(prev => ({ ...prev, [id]: msgs }));
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    for (const p of proposals) {
      if (!propMessages[p.id]) fetchPropMessages(p.id);
    }
  }, [proposals]);

  useEffect(() => {
    const onPropMsg = ({ message }: { message: ProposalMessage }) => {
      setPropMessages(prev => {
        const existing = prev[message.proposal_id] ?? [];
        if (existing.some(m => m.id === message.id)) return prev;
        return { ...prev, [message.proposal_id]: [...existing, message] };
      });
    };
    socket.on('eye:proposal:message', onPropMsg);
    return () => {
      socket.off('eye:proposal:message', onPropMsg);
    };
  }, []);

  const approveProposal = async (id: string) => {
    await fetch(`/api/eye/proposals/${id}/approve`, { method: 'POST' });
  };

  const rejectProposal = async (id: string) => {
    await fetch(`/api/eye/proposals/${id}/reject`, { method: 'POST' });
  };

  const retryProposal = async (id: string) => {
    await fetch(`/api/eye/proposals/${id}/retry`, { method: 'POST' });
  };

  const sendPropMessage = async (propId: string, content: string) => {
    await fetch(`/api/eye/proposals/${propId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    fetchPropMessages(propId);
  };

  const filteredProposals = proposals
    .filter(p => {
      if (propFilter === 'all') return true;
      if (propFilter === 'done') return ['done', 'rejected'].includes(p.status);
      if (propFilter === 'active') return !['done', 'rejected'].includes(p.status);
      // 'needs-action': pending (needs approve/reject), failed (needs retry/cancel),
      // + discussing where Eye's last msg is unread
      if (p.status === 'pending' || p.status === 'failed') return true;
      if (p.status === 'discussing') {
        const msgs = propMessages[p.id];
        if (!msgs) return false; // not loaded yet — hide until messages fetch completes
        return msgs.length === 0 || msgs[msgs.length - 1].role === 'eye';
      }
      return false;
    });

  return (
    <div className="eye-col">
      <div className="eye-col-header">
        <h3>Proposals</h3>
        <div className="eye-filter-tabs">
          <button className={`eye-filter-tab ${propFilter === 'needs-action' ? 'active' : ''}`} onClick={() => setPropFilter('needs-action')}>Needs action</button>
          <button className={`eye-filter-tab ${propFilter === 'active' ? 'active' : ''}`} onClick={() => setPropFilter('active')}>Active</button>
          <button className={`eye-filter-tab ${propFilter === 'done' ? 'active' : ''}`} onClick={() => setPropFilter('done')}>Done</button>
          <button className={`eye-filter-tab ${propFilter === 'all' ? 'active' : ''}`} onClick={() => setPropFilter('all')}>All</button>
        </div>
      </div>
      <div className="eye-col-body">
        {filteredProposals.length === 0 && <div className="eye-empty">No proposals yet</div>}
        {filteredProposals.map(p => {
          const pMsgs = propMessages[p.id] ?? [];
          const lastPMsg = pMsgs[pMsgs.length - 1];
          const propHasUnread = p.status === 'pending' || p.status === 'failed' || lastPMsg?.role === 'eye';
          return (
            <ProposalCard
              key={p.id}
              proposal={p}
              messages={pMsgs}
              hasUnread={propHasUnread}
              onApprove={approveProposal}
              onReject={rejectProposal}
              onRetry={retryProposal}
              onSendMessage={sendPropMessage}
            />
          );
        })}
      </div>
    </div>
  );
}
