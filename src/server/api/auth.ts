import { Router } from 'express';
import { authorized, sameOrigin, sessionCookie, validToken } from '../lib/auth.js';
const router = Router();
router.get('/session', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ authenticated: authorized(req.headers), required: !!process.env.AUTH_TOKEN });
});
router.post('/session', (req, res) => {
  if (!sameOrigin(req.headers)) { res.status(403).json({ error: 'Cross-origin sign-in is not allowed' }); return; }
  if (process.env.AUTH_TOKEN && !validToken(req.body?.token)) {
    res.status(401).json({ error: 'Incorrect access token' }); return;
  }
  res.setHeader('Set-Cookie', sessionCookie(req.secure));
  res.setHeader('Cache-Control', 'no-store');
  res.json({ authenticated: true });
});
router.delete('/session', (req, res) => {
  if (!sameOrigin(req.headers)) { res.sendStatus(403); return; }
  res.setHeader('Set-Cookie', sessionCookie(req.secure, true));
  res.json({ authenticated: false });
});
export default router;
