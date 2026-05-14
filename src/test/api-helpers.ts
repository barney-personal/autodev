/**
 * Shared helpers for API integration tests using supertest.
 *
 * Builds a minimal Express app with all API routes mounted at /api,
 * backed by an in-memory SQLite database. All side-effect modules
 * (SocketManager, WorkflowManager, DebateManager, AgentRunner, PtyManager,
 *  FileLockRegistry, etc.) must be mocked by the consuming test file
 *  BEFORE importing this helper.
 */
import express from 'express';
import apiRouter from '../server/api/router.js';

/**
 * Create a fresh Express app with JSON parsing and the API router mounted.
 * Call this in beforeEach AFTER setupTestDb() so the DB is ready.
 */
export function createTestApp(): express.Express {
  const app = express();
  app.use(express.json({
    verify: (req, _res, buf) => {
      (req as { rawBody?: Buffer }).rawBody = Buffer.from(buf);
    },
  }));
  app.use('/api', apiRouter);
  return app;
}
