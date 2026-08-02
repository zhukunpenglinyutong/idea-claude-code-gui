/**
 * iLink transport error taxonomy (frozen in `clawbot-ilink-transport-audit.md`).
 *
 * `errcode === -14` is never a retryable network condition: it means the bot
 * token is invalid and the adapter must stop sending until QR re-auth.
 */
export class ILinkError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ILinkError';
  }
}

export class ILinkApiError extends ILinkError {
  readonly ret: number;

  constructor(ret: number, message: string) {
    super(message);
    this.name = 'ILinkApiError';
    this.ret = ret;
  }
}

export class ILinkReauthError extends ILinkError {
  constructor(message = 'Bot token invalid (-14): QR re-auth required') {
    super(message);
    this.name = 'ILinkReauthError';
  }
}

export class ILinkNetworkError extends ILinkError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ILinkNetworkError';
  }
}

export class ILinkTimeoutError extends ILinkError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ILinkTimeoutError';
  }
}

export class ILinkRateLimitedError extends ILinkError {
  readonly retryAfterMs?: number;

  constructor(message: string, retryAfterMs?: number) {
    super(message);
    this.name = 'ILinkRateLimitedError';
    this.retryAfterMs = retryAfterMs;
  }
}

export function isReauthError(err: unknown): boolean {
  return err instanceof ILinkReauthError;
}
