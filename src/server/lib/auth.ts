import { createHmac, timingSafeEqual } from 'crypto';
import type { IncomingHttpHeaders } from 'http';

const COOKIE = 'autodev_session';
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
function equal(a: string, b: string): boolean {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
export function validToken(token: unknown): boolean {
  return typeof token === 'string' && !!process.env.AUTH_TOKEN && equal(token, process.env.AUTH_TOKEN);
}
function signature(expires: string): string {
  return createHmac('sha256', process.env.AUTH_TOKEN ?? '').update(`autodev-session:${expires}`).digest('hex');
}
export function sessionCookie(secure: boolean, logout = false): string {
  const expires = String(Date.now() + SESSION_MS);
  const value = logout ? '' : `${expires}.${signature(expires)}`;
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${logout ? 0 : SESSION_MS / 1000}${secure ? '; Secure' : ''}`;
}
export function authorized(headers: IncomingHttpHeaders): boolean {
  if (!process.env.AUTH_TOKEN) return true;
  if (headers.authorization?.startsWith('Bearer ')) return validToken(headers.authorization.slice(7));
  const value = headers.cookie?.split(';').map(part => part.trim()).find(part => part.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  if (!value) return false;
  const [expires, sig, extra] = value.split('.');
  const expiry = Number(expires);
  return !extra && !!sig && Number.isFinite(expiry) && expiry > Date.now() && expiry <= Date.now() + SESSION_MS && equal(sig, signature(expires));
}
/** Reject cross-site browser calls, including WebSocket handshakes. CLI clients have no Origin. */
export function sameOrigin(headers: IncomingHttpHeaders): boolean {
  if (!headers.origin) return true;
  try { return new URL(headers.origin).host === headers.host; } catch { return false; }
}
