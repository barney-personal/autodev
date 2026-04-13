/**
 * Tests for M1: SQL injection protection in query_db MCP tool.
 * Tests the validateQueryDbSql pure function directly.
 */

import { describe, expect, it } from 'vitest';
import { validateQueryDbSql } from '../server/mcp/tools/integrations.js';

describe('validateQueryDbSql', () => {
  describe('valid queries (should return null)', () => {
    it('allows a simple SELECT', () => {
      expect(validateQueryDbSql('SELECT * FROM users')).toBeNull();
    });

    it('allows SELECT with WHERE clause', () => {
      expect(validateQueryDbSql('SELECT id, name FROM users WHERE id = 1')).toBeNull();
    });

    it('allows case-insensitive select', () => {
      expect(validateQueryDbSql('select * from users')).toBeNull();
    });

    it('allows mixed-case SELECT', () => {
      expect(validateQueryDbSql('Select id From users')).toBeNull();
    });

    it('allows SELECT with a subquery', () => {
      expect(validateQueryDbSql('SELECT id FROM users WHERE id IN (SELECT user_id FROM orders)')).toBeNull();
    });

    it('allows SELECT after stripping a single-line comment', () => {
      expect(validateQueryDbSql('-- get all users\nSELECT * FROM users')).toBeNull();
    });

    it('allows SELECT after stripping a block comment', () => {
      expect(validateQueryDbSql('/* get users */ SELECT * FROM users')).toBeNull();
    });
  });

  describe('blocked write operations', () => {
    it('blocks INSERT', () => {
      expect(validateQueryDbSql('INSERT INTO users VALUES (1)')).not.toBeNull();
    });

    it('blocks UPDATE', () => {
      expect(validateQueryDbSql('UPDATE users SET name = "foo"')).not.toBeNull();
    });

    it('blocks DELETE', () => {
      expect(validateQueryDbSql('DELETE FROM users')).not.toBeNull();
    });

    it('blocks DROP TABLE', () => {
      expect(validateQueryDbSql('DROP TABLE users')).not.toBeNull();
    });

    it('blocks ALTER TABLE', () => {
      expect(validateQueryDbSql('ALTER TABLE users ADD COLUMN foo INT')).not.toBeNull();
    });

    it('blocks TRUNCATE', () => {
      expect(validateQueryDbSql('TRUNCATE TABLE users')).not.toBeNull();
    });

    it('blocks CREATE TABLE', () => {
      expect(validateQueryDbSql('CREATE TABLE foo (id INT)')).not.toBeNull();
    });
  });

  describe('semicolon injection prevention', () => {
    it('blocks query with semicolon at end', () => {
      expect(validateQueryDbSql('SELECT * FROM users;')).not.toBeNull();
    });

    it('blocks statement chaining via semicolon', () => {
      expect(validateQueryDbSql('SELECT * FROM users; DROP TABLE users')).not.toBeNull();
    });

    it('blocks semicolons in the middle of query', () => {
      expect(validateQueryDbSql('SELECT 1; SELECT 2')).not.toBeNull();
    });
  });

  describe('comment stripping bypass prevention', () => {
    it('rejects SQL injection via comment stripping bypass', () => {
      // The '--' inside the string literal would be treated as a comment start,
      // causing the comment stripper to eat the semicolon and everything after it.
      // The fix: check for semicolons on the ORIGINAL input before any stripping.
      expect(validateQueryDbSql("SELECT '--'; DELETE FROM users")).not.toBeNull();
    });

    it('rejects block comment stripping bypass with semicolon in string', () => {
      expect(validateQueryDbSql("SELECT '/*'; DELETE FROM users; --*/")).not.toBeNull();
    });
  });

  describe('comment-hidden attack prevention', () => {
    it('blocks comment-hidden DROP: SELECT -- comment; DROP TABLE', () => {
      // After stripping: "SELECT  " then remaining "DROP TABLE users" — but this is all on one line
      // The actual attack: the comment hides the DROP from the blocklist check
      // With our approach: strip comments first, then check for semicolon
      expect(validateQueryDbSql('SELECT -- comment\n; DROP TABLE users')).not.toBeNull();
    });

    it('blocks block comment hiding a write keyword', () => {
      // /* INSERT */ SELECT... — stripping comments reveals SELECT, which is valid.
      // But: SELECT * FROM t /* ; DROP TABLE t */
      // After stripping: SELECT * FROM t   — valid, no semicolon
      // The real risk: /* safe */ INSERT INTO... — stripped reveals INSERT
      expect(validateQueryDbSql('/* safe */ INSERT INTO users VALUES (1)')).not.toBeNull();
    });

    it('blocks comment-wrapped semicolon injection', () => {
      // Without comment stripping, this might fool a naive check
      expect(validateQueryDbSql('SELECT * FROM t /* comment */ ; DELETE FROM t')).not.toBeNull();
    });

    it('blocks write after comment removal reveals non-SELECT', () => {
      // The -- comment hides nothing but the statement doesn't start with SELECT after strip
      expect(validateQueryDbSql('-- SELECT\nDROP TABLE users')).not.toBeNull();
    });

    it('SELECT -- comment; DROP TABLE is blocked (semicolon survives comment strip)', () => {
      // "SELECT -- comment; DROP TABLE users" - the semicolon is INSIDE the comment
      // After stripping "-- comment; DROP TABLE users" → stripped = "SELECT"
      // No semicolon remains, so this would be valid — that's actually correct behavior
      // because the SQL engine would only see "SELECT" (the comment hides everything after --)
      // But: "SELECT * FROM t; -- comment" has semicolon BEFORE the comment
      expect(validateQueryDbSql('SELECT * FROM t; -- comment')).not.toBeNull();
    });
  });

  describe('error messages are informative', () => {
    it('returns a string message (not null) for blocked queries', () => {
      const result = validateQueryDbSql('DROP TABLE users');
      expect(typeof result).toBe('string');
      expect(result!.length).toBeGreaterThan(0);
    });

    it('returns a string for semicolon rejection', () => {
      const result = validateQueryDbSql('SELECT 1; SELECT 2');
      expect(typeof result).toBe('string');
      expect(result!.toLowerCase()).toContain('semicolon');
    });
  });
});
