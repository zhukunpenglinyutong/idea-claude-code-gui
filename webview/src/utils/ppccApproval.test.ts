import { describe, expect, it } from 'vitest';
import { parsePpccApprovalRequest } from './ppccApproval';

const base = {
  runId: 'run-1',
  approvalId: 'approval-1',
  diffSha256: 'a'.repeat(64),
  diff: 'diff --git a/a b/a',
};

describe('parsePpccApprovalRequest', () => {
  it('accepts millisecond timestamps', () => {
    expect(parsePpccApprovalRequest({ ...base, expiresAt: 1_700_000_000_000 }).expiresAt)
      .toBe(1_700_000_000_000);
  });

  it('normalizes Core ISO expiry timestamps', () => {
    expect(parsePpccApprovalRequest({ ...base, expiresAt: '2026-07-18T14:00:00.000Z' }).expiresAt)
      .toBe(Date.parse('2026-07-18T14:00:00.000Z'));
  });

  it('rejects invalid dates and digest bindings', () => {
    expect(() => parsePpccApprovalRequest({ ...base, expiresAt: 'invalid' })).toThrow();
    expect(() => parsePpccApprovalRequest({ ...base, diffSha256: 'short', expiresAt: Date.now() })).toThrow();
  });
});
