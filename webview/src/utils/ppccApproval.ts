import type { PpccApprovalRequest } from '../components/PpccApprovalDialog';

export function parsePpccApprovalRequest(value: unknown): PpccApprovalRequest {
  if (!value || typeof value !== 'object') {
    throw new Error('Invalid PPCC approval request');
  }
  const request = value as Record<string, unknown>;
  const expiresAt = typeof request.expiresAt === 'number'
    ? request.expiresAt
    : typeof request.expiresAt === 'string'
      ? Date.parse(request.expiresAt)
      : Number.NaN;
  if (
    typeof request.runId !== 'string' || request.runId.length === 0 ||
    typeof request.approvalId !== 'string' || request.approvalId.length === 0 ||
    typeof request.diffSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(request.diffSha256) ||
    typeof request.diff !== 'string' ||
    !Number.isFinite(expiresAt)
  ) {
    throw new Error('Invalid PPCC approval request');
  }
  return {
    runId: request.runId,
    approvalId: request.approvalId,
    diffSha256: request.diffSha256,
    diff: request.diff,
    expiresAt,
  };
}
