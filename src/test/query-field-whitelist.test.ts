/**
 * Tests for M7: Whitelist dynamic column names in update queries.
 *
 * Each update function that builds SQL from Object.entries(fields) now has an
 * explicit ALLOWED_FIELDS Set. Passing an unknown key must throw before any SQL
 * is executed; passing only known keys must not throw.
 *
 * Implementation detail exploited here: the whitelist check fires inside the
 * for-loop, before db.prepare(...).run() is called. This means we do NOT need
 * a matching row in the DB to trigger the rejection — the error is purely
 * in-memory. For the "allows" tests, SQLite UPDATE with a non-matching WHERE
 * clause is a valid no-op (0 rows affected, no error), so fake IDs work too.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDb, closeDb } from '../server/db/database.js';
import * as agentQueries from '../server/db/agentQueries.js';
import * as workflowQueries from '../server/db/workflowQueries.js';
import * as jobQueries from '../server/db/jobQueries.js';
import * as noteQueries from '../server/db/noteQueries.js';
import * as eyeQueries from '../server/db/eyeQueries.js';

const FAKE_ID = 'does-not-exist-00000000';

describe('Query field whitelisting', () => {
  beforeEach(() => {
    initDb(':memory:');
  });

  afterEach(() => {
    closeDb();
  });

  // ─── updateAgent ────────────────────────────────────────────────────────────

  describe('updateAgent', () => {
    it('rejects unknown fields', () => {
      expect(() => {
        agentQueries.updateAgent(FAKE_ID, { status: 'running', unknown_field: 'value' } as any);
      }).toThrow(/Field 'unknown_field' is not allowed for updateAgent/);
    });

    it('allows known fields without throwing', () => {
      expect(() => {
        agentQueries.updateAgent(FAKE_ID, { status: 'running', num_turns: 5 });
      }).not.toThrow();
    });
  });

  // ─── updateWorkflow ──────────────────────────────────────────────────────────

  describe('updateWorkflow', () => {
    it('rejects unknown fields', () => {
      expect(() => {
        workflowQueries.updateWorkflow(FAKE_ID, { status: 'assess', malicious_field: 'value' } as any);
      }).toThrow(/Field 'malicious_field' is not allowed for updateWorkflow/);
    });

    it('allows known fields without throwing', () => {
      expect(() => {
        workflowQueries.updateWorkflow(FAKE_ID, { current_cycle: 2, status: 'review' });
      }).not.toThrow();
    });
  });

  // ─── updateReview ────────────────────────────────────────────────────────────

  describe('updateReview', () => {
    it('rejects unknown fields', () => {
      expect(() => {
        workflowQueries.updateReview(FAKE_ID, { verdict: 'approved', hidden_field: 'value' } as any);
      }).toThrow(/Field 'hidden_field' is not allowed for updateReview/);
    });

    it('allows known fields without throwing', () => {
      expect(() => {
        workflowQueries.updateReview(FAKE_ID, { verdict: 'approved', summary: 'looks good' });
      }).not.toThrow();
    });
  });

  // ─── updateQuestion ──────────────────────────────────────────────────────────

  describe('updateQuestion', () => {
    it('rejects unknown fields', () => {
      expect(() => {
        jobQueries.updateQuestion(FAKE_ID, { status: 'answered', injection_field: 'value' } as any);
      }).toThrow(/Field 'injection_field' is not allowed for updateQuestion/);
    });

    it('allows known fields without throwing', () => {
      expect(() => {
        jobQueries.updateQuestion(FAKE_ID, { status: 'answered', answer: 'test answer' });
      }).not.toThrow();
    });
  });

  // ─── updateTemplate ──────────────────────────────────────────────────────────

  describe('updateTemplate', () => {
    it('rejects unknown fields', () => {
      expect(() => {
        noteQueries.updateTemplate(FAKE_ID, { name: 'updated', exploit_field: 'value' } as any);
      }).toThrow(/Field 'exploit_field' is not allowed for updateTemplate/);
    });

    it('allows known fields without throwing', () => {
      expect(() => {
        noteQueries.updateTemplate(FAKE_ID, { name: 'updated template', content: 'new content' });
      }).not.toThrow();
    });
  });

  // ─── updateProject ───────────────────────────────────────────────────────────

  describe('updateProject', () => {
    it('rejects unknown fields', () => {
      expect(() => {
        noteQueries.updateProject(FAKE_ID, { name: 'updated', backdoor_field: 'value' } as any);
      }).toThrow(/Field 'backdoor_field' is not allowed for updateProject/);
    });

    it('allows known fields without throwing', () => {
      expect(() => {
        noteQueries.updateProject(FAKE_ID, { name: 'updated project', description: 'desc' });
      }).not.toThrow();
    });
  });

  // ─── updateDebate ────────────────────────────────────────────────────────────

  describe('updateDebate', () => {
    it('rejects unknown fields', () => {
      expect(() => {
        noteQueries.updateDebate(FAKE_ID, { status: 'in_progress', sql_injection: 'value' } as any);
      }).toThrow(/Field 'sql_injection' is not allowed for updateDebate/);
    });

    it('allows known fields without throwing', () => {
      expect(() => {
        noteQueries.updateDebate(FAKE_ID, { current_round: 2, consensus: 'test consensus' });
      }).not.toThrow();
    });
  });

  // ─── updateKBEntry ───────────────────────────────────────────────────────────

  describe('updateKBEntry', () => {
    it('rejects unknown fields', () => {
      expect(() => {
        eyeQueries.updateKBEntry(FAKE_ID, { title: 'updated', drop_table: 'value' } as any);
      }).toThrow(/Field 'drop_table' is not allowed for updateKBEntry/);
    });

    it('allows known fields without throwing', () => {
      expect(() => {
        eyeQueries.updateKBEntry(FAKE_ID, { title: 'updated entry', content: 'new content' });
      }).not.toThrow();
    });
  });

  // ─── mixed field combinations ────────────────────────────────────────────────

  describe('field combinations', () => {
    it('rejects if any field among otherwise-valid fields is unknown', () => {
      // Even if some fields are valid, the first unknown one encountered throws
      expect(() => {
        agentQueries.updateAgent(FAKE_ID, {
          status: 'running',
          num_turns: 5,
          bad_field: 'attack',
        } as any);
      }).toThrow(/Field 'bad_field' is not allowed for updateAgent/);
    });

    it('allows multiple valid fields across updateWorkflow', () => {
      expect(() => {
        workflowQueries.updateWorkflow(FAKE_ID, {
          current_cycle: 2,
          current_phase: 'review',
          status: 'in_progress',
          milestones_total: 5,
          milestones_done: 2,
        });
      }).not.toThrow();
    });

    it('rejects SQL-comment-style field names', () => {
      // A field name containing SQL syntax characters must be rejected before
      // it reaches db.prepare(), preventing column-name injection attacks.
      expect(() => {
        agentQueries.updateAgent(FAKE_ID, { 'status--injected': 'evil' } as any);
      }).toThrow(/Field 'status--injected' is not allowed for updateAgent/);
    });

    it('rejects constructor injection attempt', () => {
      expect(() => {
        workflowQueries.updateWorkflow(FAKE_ID, { constructor: 'evil' } as any);
      }).toThrow(/Field 'constructor' is not allowed for updateWorkflow/);
    });
  });
});
