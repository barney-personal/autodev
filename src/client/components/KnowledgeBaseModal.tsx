import { useState, useEffect, useCallback } from 'react';
import type { KBEntry } from '@shared/types';

interface KnowledgeBaseModalProps {
  onClose: () => void;
}

export function KnowledgeBaseModal({ onClose }: KnowledgeBaseModalProps) {
  const [entries, setEntries] = useState<KBEntry[]>([]);
  const [search, setSearch] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [tags, setTags] = useState('');

  const fetchEntries = useCallback(async () => {
    try {
      const url = search.trim()
        ? `/api/knowledge-base/search?q=${encodeURIComponent(search.trim())}`
        : '/api/knowledge-base';
      const res = await fetch(url);
      if (res.ok) setEntries(await res.json());
    } catch { /* ignore */ }
  }, [search]);

  useEffect(() => { fetchEntries(); }, [fetchEntries]);

  const handleAdd = async () => {
    if (!title.trim() || !content.trim()) return;
    await fetch('/api/knowledge-base', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: title.trim(), content: content.trim(), tags: tags.trim() || null }),
    });
    setTitle(''); setContent(''); setTags(''); setShowAdd(false);
    fetchEntries();
  };

  const handleUpdate = async () => {
    if (!editId || !title.trim() || !content.trim()) return;
    await fetch(`/api/knowledge-base/${editId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: title.trim(), content: content.trim(), tags: tags.trim() || null }),
    });
    setEditId(null); setTitle(''); setContent(''); setTags(''); setShowAdd(false);
    fetchEntries();
  };

  const handleDelete = async (id: string) => {
    await fetch(`/api/knowledge-base/${id}`, { method: 'DELETE' });
    fetchEntries();
  };

  const startEdit = (entry: KBEntry) => {
    setEditId(entry.id);
    setTitle(entry.title);
    setContent(entry.content);
    setTags(entry.tags ?? '');
    setShowAdd(true);
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-lg" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Knowledge Base</h2>
          <button className="btn-icon" onClick={onClose}>&times;</button>
        </div>
        <div className="modal-body">
          <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
            <input
              type="text"
              placeholder="Search knowledge base..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              style={{ flex: 1 }}
            />
            <button className="btn btn-primary btn-sm" onClick={() => { setShowAdd(true); setEditId(null); setTitle(''); setContent(''); setTags(''); }}>
              + Add
            </button>
          </div>

          {showAdd && (
            <div style={{ border: '1px solid var(--border)', borderRadius: 6, padding: 12, marginBottom: 12, background: 'var(--bg-elevated)' }}>
              <div className="form-group">
                <label>Title</label>
                <input type="text" value={title} onChange={e => setTitle(e.target.value)} placeholder="Entry title" />
              </div>
              <div className="form-group">
                <label>Content</label>
                <textarea value={content} onChange={e => setContent(e.target.value)} rows={4} placeholder="Knowledge content..." />
              </div>
              <div className="form-group">
                <label>Tags <span className="form-label-hint">(comma-separated)</span></label>
                <input type="text" value={tags} onChange={e => setTags(e.target.value)} placeholder="tag1, tag2" />
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn btn-primary btn-sm" onClick={editId ? handleUpdate : handleAdd}>
                  {editId ? 'Update' : 'Add'}
                </button>
                <button className="btn btn-secondary btn-sm" onClick={() => { setShowAdd(false); setEditId(null); }}>
                  Cancel
                </button>
              </div>
            </div>
          )}

          <div style={{ maxHeight: 400, overflowY: 'auto' }}>
            {entries.length === 0 && <div style={{ color: 'var(--text-muted)', padding: 20, textAlign: 'center' }}>No entries found</div>}
            {entries.map(entry => (
              <div key={entry.id} style={{ borderBottom: '1px solid var(--border)', padding: '10px 0' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <strong style={{ fontSize: 14 }}>{entry.title}</strong>
                  <div style={{ display: 'flex', gap: 4 }}>
                    <button className="btn-icon" onClick={() => startEdit(entry)} title="Edit" style={{ fontSize: 12 }}>Edit</button>
                    <button className="btn-icon" onClick={() => handleDelete(entry.id)} title="Delete" style={{ fontSize: 12, color: 'var(--danger)' }}>Del</button>
                  </div>
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4, whiteSpace: 'pre-wrap' }}>
                  {entry.content.length > 200 ? entry.content.slice(0, 200) + '...' : entry.content}
                </div>
                {entry.tags && (
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                    {entry.tags.split(',').map(t => t.trim()).filter(Boolean).map(t => (
                      <span key={t} style={{ background: 'var(--bg-interactive)', borderRadius: 3, padding: '1px 5px', marginRight: 4 }}>{t}</span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
