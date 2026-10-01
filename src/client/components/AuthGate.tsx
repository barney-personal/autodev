import { useEffect, useState, type ReactNode, type FormEvent } from 'react';
import socket from '../socket';

export function AuthGate({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/auth/session', { signal: controller.signal })
      .then(r => { if (!r.ok) throw new Error('Unable to connect'); return r.json(); })
      .then(data => { setAuthenticated(data.authenticated); setReady(true); })
      .catch(err => { if (err.name !== 'AbortError') { setError('Unable to connect to Autodev. Reload to retry.'); setReady(true); } });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    if (authenticated) socket.connect();
    else socket.disconnect();
    const denied = (err: Error) => { if (err.message === 'Unauthorized') setAuthenticated(false); };
    const disconnected = (reason: string) => { if (reason === 'io server disconnect') setAuthenticated(false); };
    socket.on('connect_error', denied);
    socket.on('disconnect', disconnected);
    return () => { socket.off('connect_error', denied); socket.off('disconnect', disconnected); socket.disconnect(); };
  }, [authenticated]);
  async function signIn(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const response = await fetch('/api/auth/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
      if (!response.ok) throw new Error(response.status === 401 ? 'Incorrect access token.' : 'Unable to sign in. Try again.');
      setToken(''); setAuthenticated(true);
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }
  if (authenticated) return <>{children}</>;
  return <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24 }}>
    <form onSubmit={signIn} style={{ width: '100%', maxWidth: 360, display: 'grid', gap: 16 }}>
      <h1>Autodev</h1>
      <p>{ready ? 'Sign in to manage your autonomous development workspace.' : 'Connecting to your workspace…'}</p>
      {ready && <><label htmlFor="access-token">Access token</label>
        <input id="access-token" type="password" autoComplete="current-password" value={token} onChange={e => setToken(e.target.value)} required autoFocus />
        <button type="submit" disabled={busy || !token}>{busy ? 'Signing in…' : 'Sign in'}</button></>}
      {error && <p role="alert">{error}</p>}
    </form>
  </main>;
}
