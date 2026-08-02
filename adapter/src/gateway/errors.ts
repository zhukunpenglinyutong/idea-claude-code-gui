/**
 * Gateway error classification.
 *
 * The adapter must distinguish errors by `code` (e.g. `TAB_BUSY` is not a
 * generic 409), per `REMOTE_GATEWAY_API_EVENT_CONTRACT_V1.md` §11.
 */
export type GatewayErrorKind =
  | 'network'
  | 'timeout'
  | 'auth'
  | 'not_found'
  | 'busy'
  | 'invalid'
  | 'http'
  | 'overflow';

export class GatewayError extends Error {
  readonly kind: GatewayErrorKind;
  readonly status?: number;
  readonly code?: string;

  constructor(
    kind: GatewayErrorKind,
    message: string,
    options?: { status?: number; code?: string; cause?: unknown },
  ) {
    super(message, { cause: options?.cause });
    this.name = 'GatewayError';
    this.kind = kind;
    this.status = options?.status;
    this.code = options?.code;
  }
}

export interface RemoteErrorBody {
  error?: { code?: string; message?: string };
}

export function parseErrorBody(text: string): RemoteErrorBody {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === 'object' && parsed !== null) {
      return parsed as RemoteErrorBody;
    }
  } catch {
    // Non-JSON error bodies fall back to the generic HTTP message.
  }
  return {};
}

export function classifyHttpError(status: number, code: string | undefined, message: string): GatewayError {
  if (status === 401 || status === 403) {
    return new GatewayError('auth', message, { status, code });
  }
  if (status === 404) {
    return new GatewayError('not_found', message, { status, code });
  }
  if (status === 409 && code === 'TAB_BUSY') {
    return new GatewayError('busy', message, { status, code });
  }
  if (status === 409) {
    return new GatewayError('invalid', message, { status, code });
  }
  return new GatewayError('http', message, { status, code });
}

export function isGatewayError(err: unknown, kind: GatewayErrorKind): boolean {
  return err instanceof GatewayError && err.kind === kind;
}
