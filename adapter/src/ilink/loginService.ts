import { randomUUID } from 'node:crypto';
import QRCode from 'qrcode';
import { ILinkClient } from './client.js';
import { runQrAuthorization } from './qr.js';
import { CredentialStore, type BotCredentials } from './store.js';

export type LoginSessionStatus =
  | 'QR_PENDING'
  | 'SCANNED'
  | 'VERIFY_CODE_REQUIRED'
  | 'CONFIRMED'
  | 'EXPIRED'
  | 'CANCELLED'
  | 'ERROR';

export interface LoginSessionView {
  readonly loginId: string;
  readonly status: LoginSessionStatus;
  readonly expiresAt: number;
  readonly verifyCodeRequired: boolean;
  readonly qrUrl?: string;
  readonly botAccountId?: string;
}

export interface WechatLoginServiceOptions {
  readonly store: CredentialStore;
  readonly onConfirmed?: (credentials: BotCredentials) => void;
  readonly onStateChange?: () => void;
  readonly timeoutMs?: number;
  readonly maxRefresh?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly createClient?: (baseUrl: string) => ILinkClient;
}

interface ActiveLogin {
  readonly loginId: string;
  readonly abort: AbortController;
  status: LoginSessionStatus;
  expiresAt: number;
  verifyCodeRequired: boolean;
  qrUrl?: string;
  qrPng?: Buffer;
  botAccountId?: string;
  cancelled: boolean;
  pendingVerify?: (code: string) => void;
  pendingReject?: (err: Error) => void;
  pendingCode?: string;
}

const DEFAULT_TIMEOUT_MS = 480_000;

/**
 * Structured QR login session service.
 *
 * Drives the single iLink login implementation (`src/ilink/qr.ts`) with
 * injected display/verify-code callbacks and exposes live session state.
 * At most one active login session exists; a terminal session is retained
 * briefly so control clients can still query the final state.
 */
export class WechatLoginService {
  readonly #options: WechatLoginServiceOptions;
  #active?: ActiveLogin;
  #last?: ActiveLogin;

  constructor(options: WechatLoginServiceOptions) {
    this.#options = options;
  }

  startLogin(): LoginSessionView {
    if (this.#active !== undefined) {
      const current = this.#active;
      if (!current.cancelled && !current.abort.signal.aborted) {
        return this.#view();
      }
      // A login that is being cancelled is terminal: replace it immediately so
      // a refresh issued right after cancel gets a fresh session instead of
      // the dying one (E2E-P2-006). The old #run loop observes the identity
      // change in its finally block and never clobbers the new session.
      current.status = 'CANCELLED';
      current.abort.abort();
      this.#last = current;
      this.#active = undefined;
    }
    const active: ActiveLogin = {
      loginId: randomUUID(),
      abort: new AbortController(),
      status: 'QR_PENDING',
      expiresAt: Date.now() + (this.#options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      verifyCodeRequired: false,
      cancelled: false,
    };
    this.#active = active;
    void this.#run(active);
    return this.#view();
  }

  get activeLoginId(): string | undefined {
    return this.#active?.loginId;
  }

  get(loginId: string): LoginSessionView | undefined {
    if (this.#active !== undefined && this.#active.loginId === loginId) {
      return this.#view();
    }
    if (this.#last !== undefined && this.#last.loginId === loginId) {
      return {
        loginId: this.#last.loginId,
        status: this.#last.status,
        expiresAt: this.#last.expiresAt,
        verifyCodeRequired: false,
        qrUrl: this.#last.qrUrl,
        botAccountId: this.#last.botAccountId,
      };
    }
    return undefined;
  }

  getQrPng(loginId: string): Buffer | undefined {
    if (this.#active !== undefined && this.#active.loginId === loginId) {
      return this.#active.qrPng;
    }
    if (this.#last !== undefined && this.#last.loginId === loginId) {
      return this.#last.qrPng;
    }
    return undefined;
  }

  submitVerifyCode(loginId: string, code: string): boolean {
    const active = this.#active;
    if (active === undefined || active.loginId !== loginId || active.cancelled) {
      return false;
    }
    const trimmed = code.trim();
    if (trimmed.length === 0) {
      return false;
    }
    if (active.pendingVerify !== undefined) {
      const resolve = active.pendingVerify;
      active.pendingVerify = undefined;
      active.pendingReject = undefined;
      resolve(trimmed);
    } else {
      active.pendingCode = trimmed;
    }
    return true;
  }

  cancel(loginId: string): boolean {
    const active = this.#active;
    if (active === undefined || active.loginId !== loginId || active.cancelled) {
      return false;
    }
    active.cancelled = true;
    active.abort.abort();
    if (active.pendingReject !== undefined) {
      const reject = active.pendingReject;
      active.pendingReject = undefined;
      active.pendingVerify = undefined;
      reject(new Error('CANCELLED'));
    }
    return true;
  }

  #view(): LoginSessionView {
    const active = this.#active;
    if (active === undefined) {
      throw new Error('No active login session');
    }
    return {
      loginId: active.loginId,
      status: active.status,
      expiresAt: active.expiresAt,
      verifyCodeRequired: active.verifyCodeRequired,
      qrUrl: active.qrUrl,
      botAccountId: active.botAccountId,
    };
  }

  async #run(active: ActiveLogin): Promise<void> {
    try {
      const result = await runQrAuthorization({
        createClient:
          this.#options.createClient ?? ((baseUrl) => new ILinkClient({ baseUrl, botToken: '' })),
        store: this.#options.store,
        display: async (url) => {
          active.qrUrl = url;
          try {
            active.qrPng = await QRCode.toBuffer(url, { width: 320, margin: 1 });
          } catch {
            active.qrPng = undefined;
          }
          this.#options.onStateChange?.();
        },
        readVerifyCode: () =>
          new Promise<string>((resolve, reject) => {
            if (active.cancelled) {
              reject(new Error('CANCELLED'));
              return;
            }
            active.status = 'VERIFY_CODE_REQUIRED';
            active.verifyCodeRequired = true;
            this.#options.onStateChange?.();
            if (active.pendingCode !== undefined) {
              const code = active.pendingCode;
              active.pendingCode = undefined;
              resolve(code);
              return;
            }
            active.pendingVerify = resolve;
            active.pendingReject = reject;
          }),
        sleep: this.#options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
        timeoutMs: this.#options.timeoutMs,
        maxRefresh: this.#options.maxRefresh,
        onStatus: (status) => {
          switch (status) {
            case 'wait':
              if (active.status !== 'VERIFY_CODE_REQUIRED') {
                active.status = 'QR_PENDING';
              }
              break;
            case 'scaned':
              active.status = 'SCANNED';
              break;
            case 'need_verifycode':
            case 'verify_code_blocked':
              active.status = 'VERIFY_CODE_REQUIRED';
              break;
            case 'expired':
              active.status = 'EXPIRED';
              break;
            default:
              break;
          }
          this.#options.onStateChange?.();
        },
        isCancelled: () => active.cancelled,
        signal: active.abort.signal,
      });
      if (this.#active?.loginId !== active.loginId) {
        return;
      }
      if (active.cancelled) {
        active.status = 'CANCELLED';
      } else if (result.ok && result.credentials !== undefined) {
        active.status = 'CONFIRMED';
        active.verifyCodeRequired = false;
        active.botAccountId = result.credentials.botAccountId;
        this.#options.onConfirmed?.(result.credentials);
      } else if (result.alreadyConnected) {
        const existing = await this.#options.store.loadBotCredentials();
        if (existing !== undefined) {
          active.status = 'CONFIRMED';
          active.botAccountId = existing.botAccountId;
          this.#options.onConfirmed?.(existing);
        } else {
          active.status = 'ERROR';
        }
      } else if (active.status !== 'EXPIRED') {
        active.status = 'ERROR';
      }
      this.#options.onStateChange?.();
    } catch (err) {
      if (this.#active?.loginId === active.loginId) {
        active.status = active.cancelled ? 'CANCELLED' : 'ERROR';
        this.#options.onStateChange?.();
      }
    } finally {
      if (this.#active?.loginId === active.loginId) {
        this.#active = undefined;
        this.#last = active;
      }
    }
  }
}
