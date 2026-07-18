export const MAX_DAEMON_LINE_BYTES = 1_048_576;

function requireBoundString(value, name, maxLength = 256) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw new Error(`${name} must be a non-empty bounded string`);
  }
  return value;
}

/** Parse one fail-closed NDJSON request from Java. */
export function parseDaemonRequestLine(line) {
  if (typeof line !== 'string') throw new Error('Daemon request line must be a string');
  if (Buffer.byteLength(line, 'utf8') > MAX_DAEMON_LINE_BYTES) {
    throw new Error(`Daemon request exceeds maximum line size (${MAX_DAEMON_LINE_BYTES} bytes)`);
  }
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    throw new Error('Invalid daemon request JSON');
  }
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new Error('Daemon request must be an object');
  }
  request.id = requireBoundString(request.id, 'id');
  request.method = requireBoundString(request.method, 'method');
  if (request.params !== undefined && (!request.params || typeof request.params !== 'object' || Array.isArray(request.params))) {
    throw new Error('params must be an object');
  }
  return request;
}

/** Validate the immutable PPCC final-diff approval binding. */
export function validatePpccApprovalParams(params) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    throw new Error('PPCC approval params must be an object');
  }
  const runId = requireBoundString(params.runId, 'runId');
  const approvalId = requireBoundString(params.approvalId, 'approvalId');
  const diffSha256 = requireBoundString(params.diffSha256, 'diffSha256', 64);
  if (!/^[a-f0-9]{64}$/i.test(diffSha256)) {
    throw new Error('diffSha256 must be a SHA-256 hex digest');
  }
  return { runId, approvalId, diffSha256: diffSha256.toLowerCase() };
}
