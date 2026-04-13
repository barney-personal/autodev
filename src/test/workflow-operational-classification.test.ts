/**
 * Unit tests for `isOperationalBlockedReason` — the classifier that decides
 * whether a blocked workflow's reason should fire a Sentry capture.
 *
 * Regression tests for the cascade discovered in HURLICANE-5J / HURLICANE-9E:
 * a "Sentry fix" workflow whose own target failed with an operational error
 * (e.g. timeout) had its blocked_reason prefixed with error-type and nested
 * "Workflow blocked: ..." strings. The original regex was anchored with
 * `^...$` and only matched reasons that STARTED with `Phase 'X' job Y
 * failed (kind)` — nested reasons slipped through and were captured as
 * errors, spawning MORE Sentry-fix workflows in an infinite loop.
 */

import { describe, it, expect } from 'vitest';
import { _isOperationalBlockedReasonForTest as isOperationalBlockedReason } from '../server/orchestrator/WorkflowManager.js';

describe('isOperationalBlockedReason', () => {
  describe('substring-based operational reasons', () => {
    const cases = [
      'Reached max cycles',
      'Workflow has no milestone progress after 2 cycles',
      'Diminishing returns — halting',
      'PR creation failed after 3 attempts',
      'Draft PR creation failed — worktree preserved',
      'was cancelled by user',
      'no fallback model available',
    ];
    for (const reason of cases) {
      it(`classifies "${reason}" as operational`, () => {
        expect(isOperationalBlockedReason(reason)).toBe(true);
      });
    }
  });

  describe('model-fallback recovery exhausted — kind-dependent', () => {
    it('classifies model-fallback exhausted with operational kind as operational', () => {
      expect(isOperationalBlockedReason(
        "Phase 'implement' job abcdef12 failed (rate_limit) — model-fallback recovery exhausted",
      )).toBe(true);
    });

    it('does NOT classify model-fallback exhausted with non-operational kind as operational', () => {
      expect(isOperationalBlockedReason(
        "Phase 'implement' job abcdef12 failed (auth_failure) — model-fallback recovery exhausted",
      )).toBe(false);
    });
  });

  describe('Phase failed (kind) regex — bare form', () => {
    it("classifies `Phase 'implement' job abcdef12 failed (timeout)` as operational", () => {
      expect(isOperationalBlockedReason("Phase 'implement' job abcdef12 failed (timeout)")).toBe(true);
    });

    it("classifies `Phase 'review' job 11223344 failed (out_of_memory)` as operational", () => {
      expect(isOperationalBlockedReason("Phase 'review' job 11223344 failed (out_of_memory)")).toBe(true);
    });

    it("classifies `Phase 'assess' job deadbeef failed (mcp_disconnect)` as operational", () => {
      expect(isOperationalBlockedReason("Phase 'assess' job deadbeef failed (mcp_disconnect)")).toBe(true);
    });

    it("classifies `Phase 'implement' job abcdef12 failed (launch_environment)` as operational", () => {
      expect(isOperationalBlockedReason("Phase 'implement' job abcdef12 failed (launch_environment)")).toBe(true);
    });

    it("does NOT classify `Phase 'implement' job abcdef12 failed (task_failure)` as operational", () => {
      expect(isOperationalBlockedReason("Phase 'implement' job abcdef12 failed (task_failure)")).toBe(false);
    });
  });

  describe('nested / prefixed reasons (HURLICANE-5J regression)', () => {
    it("classifies `BrokenPipeErr — Phase 'implement' job 54947c3f failed (timeout)` as operational", () => {
      expect(
        isOperationalBlockedReason("BrokenPipeErr — Phase 'implement' job 54947c3f failed (timeout)"),
      ).toBe(true);
    });

    it('classifies a double-nested Sentry-fix cascade reason as operational', () => {
      const reason =
        "WorkflowBlocked: Workflow blocked: Sentry fix [investor-pipeline]: BrokenPipeErr — Phase 'implement' job 54947c3f failed (timeout)";
      expect(isOperationalBlockedReason(reason)).toBe(true);
    });

    it('classifies a triple-nested Sentry-fix cascade reason as operational', () => {
      // From HURLICANE-5J in the wild.
      const reason =
        "Sentry fix [hurlicane]: WorkflowBlocked: Workflow blocked: Sentry fix [investor-pipeline]: BrokenPipeErr — Phase 'implement' job 54947c3f failed (timeout)";
      expect(isOperationalBlockedReason(reason)).toBe(true);
    });

    it('classifies a nested launch_environment (PTY exhaustion) as operational', () => {
      const reason =
        "WorkflowBlocked: Workflow blocked: Sentry fix [hurlicane]: Error: Standalone print job failed via no_terminal_evidence — Phase 'implement' job 0a23e7d5 failed (launch_environment)";
      expect(isOperationalBlockedReason(reason)).toBe(true);
    });

    it('still refuses to classify a nested task_failure as operational', () => {
      const reason =
        "WorkflowBlocked: Workflow blocked: Something — Phase 'implement' job deadbeef failed (task_failure)";
      expect(isOperationalBlockedReason(reason)).toBe(false);
    });
  });

  describe('non-matching reasons', () => {
    it('does NOT classify a generic error string as operational', () => {
      expect(isOperationalBlockedReason('Agent produced invalid output')).toBe(false);
    });

    it('does NOT classify an empty string as operational', () => {
      expect(isOperationalBlockedReason('')).toBe(false);
    });
  });
});
