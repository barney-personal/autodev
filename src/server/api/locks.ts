import { Router } from 'express';
import * as queries from '../db/queries.js';
import * as socket from '../socket/SocketManager.js';
import { CHECKOUT_PREFIX } from '../orchestrator/FileLockRegistry.js';

const router = Router();

router.get('/', (_req, res) => {
  res.json(queries.getAllActiveLocks());
});

// Check if a specific agent holds a lock for a file (used by the Edit/Write PreToolUse hook).
// Returns locked:true if the agent holds either a direct file lock OR a checkout:: lock
// whose directory covers the requested file.
router.get('/check', (req, res) => {
  const { agent_id, file } = req.query as { agent_id?: string; file?: string };
  if (!agent_id || !file) {
    res.status(400).json({ error: 'agent_id and file required' });
    return;
  }
  const activeLocks = queries.getActiveLocksForFile(file);
  if (activeLocks.some(l => l.agent_id === agent_id)) {
    res.json({ locked: true });
    return;
  }
  // Also accept a checkout:: lock covering this file
  const checkoutLocks = queries.getAllActiveCheckoutLocks();
  const hasCheckout = checkoutLocks.some(l => {
    if (l.agent_id !== agent_id) return false;
    const dir = l.file_path.slice(CHECKOUT_PREFIX.length);
    return file.startsWith(dir + '/') || file === dir;
  });
  res.json({ locked: hasCheckout });
});

// Check if a specific agent holds a checkout:: lock covering a directory.
// Used by the Bash PreToolUse hook when intercepting destructive git commands.
// Query params: agent_id, dir (absolute path to the working directory or git root)
router.get('/check-checkout', (req, res) => {
  const { agent_id, dir } = req.query as { agent_id?: string; dir?: string };
  if (!agent_id || !dir) {
    res.status(400).json({ error: 'agent_id and dir required' });
    return;
  }
  const checkoutLocks = queries.getAllActiveCheckoutLocks();
  // The agent must hold checkout::X where X is a prefix of (or equal to) dir
  const locked = checkoutLocks.some(l => {
    if (l.agent_id !== agent_id) return false;
    const lockDir = l.file_path.slice(CHECKOUT_PREFIX.length);
    return dir.startsWith(lockDir + '/') || dir === lockDir || lockDir.startsWith(dir + '/') || lockDir === dir;
  });
  res.json({ locked });
});

router.delete('/:id', (req, res) => {
  const { agent_id } = req.query as { agent_id?: string };
  if (!agent_id) {
    res.status(400).json({ error: 'agent_id required' });
    return;
  }
  const lock = queries.getFileLockById(req.params.id);
  if (!lock) { res.status(404).json({ error: 'not found' }); return; }
  if (lock.agent_id !== agent_id) {
    res.status(403).json({ error: 'forbidden' });
    return;
  }
  queries.releaseLock(lock.id);
  socket.emitLockReleased(lock.id, lock.file_path);
  res.json({ ok: true });
});

export default router;
