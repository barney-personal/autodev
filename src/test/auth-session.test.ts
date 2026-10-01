import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createServer } from 'http';
import { io as connect } from 'socket.io-client';
import authRouter from '../server/api/auth.js';
import { authorized, sessionCookie, sameOrigin } from '../server/lib/auth.js';
import { initSocketManager } from '../server/socket/SocketManager.js';

beforeEach(() => { vi.stubEnv('AUTH_TOKEN', 'test-secret'); });
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });
const app = express().use(express.json()).use('/auth', authRouter);
describe('authenticated browser sessions', () => {
  it('sets an HttpOnly cookie without returning the access token', async () => {
    const r = await request(app).post('/auth/session').send({ token: 'test-secret' });
    expect(r.status).toBe(200);
    const cookie = r.headers['set-cookie'][0];
    expect(cookie).toContain('HttpOnly'); expect(cookie).toContain('SameSite=Strict');
    expect(cookie).not.toContain('test-secret');
    expect(authorized({ cookie })).toBe(true);
    expect((await request(app).get('/auth/session').set('Cookie', cookie)).body.authenticated).toBe(true);
    expect((await request(app).post('/auth/session').send({ token: 'wrong' })).status).toBe(401);
  });
  it('rejects forged, expired, rotated and cross-origin credentials', () => {
    const cookie = sessionCookie(true);
    expect(cookie).toContain('Secure');
    expect(authorized({ cookie: cookie.replace(/\.[a-f0-9]+;/, '.forged;') })).toBe(false);
    vi.useFakeTimers(); vi.setSystemTime(Date.now() + 8 * 86400000);
    expect(authorized({ cookie })).toBe(false);
    vi.useRealTimers(); vi.stubEnv('AUTH_TOKEN', 'rotated');
    expect(authorized({ cookie })).toBe(false);
    expect(sameOrigin({ origin: 'https://evil.example', host: 'localhost:3456' })).toBe(false);
    expect(sameOrigin({ origin: 'http://localhost:3456', host: 'localhost:3456' })).toBe(true);
    expect(authorized({ authorization: 'Bearer rotated' })).toBe(true);
  });
  it('rejects cross-origin login/logout and a wrong bearer even with a valid cookie', async () => {
    expect((await request(app).post('/auth/session').set('Origin', 'https://other.example').send({ token: 'test-secret' })).status).toBe(403);
    expect((await request(app).delete('/auth/session').set('Origin', 'https://other.example')).status).toBe(403);
    expect(authorized({ cookie: sessionCookie(false), authorization: 'Bearer wrong' })).toBe(false);
  });
  it('requires the same credentials for sockets as for the API', async () => {
    const server = createServer();
    const io = initSocketManager(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const anonymous = connect(`http://127.0.0.1:${port}`, { transports: ['websocket'], reconnection: false });
    const signedIn = connect(`http://127.0.0.1:${port}`, { transports: ['websocket'], reconnection: false, extraHeaders: { Cookie: sessionCookie(false) } });
    try {
      const rejected = new Promise<string>(resolve => anonymous.on('connect_error', err => resolve(err.message)));
      const accepted = new Promise<void>((resolve, reject) => { signedIn.on('connect', resolve); signedIn.on('connect_error', reject); });
      expect(await rejected).toBe('Unauthorized');
      await accepted;
    } finally {
      anonymous.disconnect(); signedIn.disconnect();
      await new Promise<void>(resolve => io.close(() => resolve()));
    }
  });
});
