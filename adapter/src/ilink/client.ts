import {
  ILinkApiError,
  ILinkNetworkError,
  ILinkRateLimitedError,
  ILinkReauthError,
  ILinkTimeoutError,
} from './errors.js';
import {
  ILINK_APP_ID,
  TOKEN_INVALID_RET,
  type GetConfigResponse,
  type GetUpdatesResponse,
  type NotifyResponse,
  type QrCodeResponse,
  type QrStatusResponse,
  type SendMessageOut,
  type SendMessageResponse,
  type SendTypingResponse,
} from './types.js';
import crypto from 'node:crypto';

export interface ILinkClientOptions {
  /** Base URL from QR confirmation (e.g. `https://api.ilink.example`). */
  readonly baseUrl: string;
  readonly botToken: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly channelVersion?: string;
  readonly botAgent?: string;
  readonly appId?: string;
}

export interface RequestOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

interface ResponseEnvelope {
  readonly ret?: unknown;
  readonly errcode?: unknown;
  readonly errmsg?: unknown;
}

/**
 * Minimal HTTP/JSON client for the official iLink bot endpoints.
 *
 * Auth is `AuthorizationType: ilink_bot_token` + `Authorization: Bearer <token>`
 * (audit §5.1). The token is never logged.
 */
export class ILinkClient {
  readonly #options: ILinkClientOptions;

  constructor(options: ILinkClientOptions) {
    this.#options = options;
  }

  #base(path: string): string {
    return `${this.#options.baseUrl.replace(/\/+$/, '')}${path}`;
  }

  #baseInfo(): { channel_version: string; bot_agent: string } {
    return {
      channel_version: this.#options.channelVersion ?? '0.1.0',
      bot_agent: this.#options.botAgent ?? 'CCGUI-WeChat/0.1.0',
    };
  }

  #buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      AuthorizationType: 'ilink_bot_token',
      Authorization: `Bearer ${this.#options.botToken}`,
      'iLink-App-Id': this.#options.appId ?? ILINK_APP_ID,
      'iLink-App-ClientVersion': String(encodeClientVersion(this.#options.channelVersion ?? '0.1.0')),
      'X-WECHAT-UIN': randomWechatUin(),
    };
    return headers;
  }

  async request<T>(method: string, path: string, body?: unknown, options: RequestOptions = {}): Promise<T> {
    const fetchImpl = this.#options.fetchImpl ?? fetch;
    const timeoutMs = options.timeoutMs ?? this.#options.timeoutMs ?? 15_000;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new ILinkTimeoutError(`iLink request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const onExternalAbort = (): void => controller.abort();
    options.signal?.addEventListener('abort', onExternalAbort, { once: true });
    try {
      let response: Response;
      try {
        response = await fetchImpl(this.#base(path), {
          method,
          headers: this.#buildHeaders(),
          body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
          signal: controller.signal,
        });
      } catch (cause) {
        if (controller.signal.aborted) {
          throw cause instanceof ILinkTimeoutError
            ? cause
            : new ILinkTimeoutError('iLink request timed out', { cause });
        }
        throw new ILinkNetworkError(`Cannot reach iLink at ${this.#options.baseUrl}`, { cause });
      }
      if (response.status === 429) {
        const retryAfter = response.headers.get('retry-after');
        const retryAfterMs = retryAfter !== null ? Number(retryAfter) * 1000 : undefined;
        throw new ILinkRateLimitedError(
          'iLink rate limited (429)',
          Number.isFinite(retryAfterMs) ? retryAfterMs : undefined,
        );
      }
      const text = await response.text();
      let parsed: ResponseEnvelope = {};
      try {
        parsed = JSON.parse(text) as ResponseEnvelope;
      } catch {
        // Non-JSON body: fall back to HTTP status below.
      }
      if (parsed.errcode === TOKEN_INVALID_RET || parsed.ret === TOKEN_INVALID_RET) {
        throw new ILinkReauthError();
      }
      const ret = parsed.ret;
      if (typeof ret === 'number' && ret !== 0) {
        throw new ILinkApiError(ret, typeof parsed.errmsg === 'string' ? parsed.errmsg : `iLink ret=${ret}`);
      }
      if (!response.ok) {
        throw new ILinkApiError(response.status, `iLink HTTP ${response.status}`);
      }
      return parsed as T;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onExternalAbort);
    }
  }

  async getUpdates(
    cursor: string,
    options: RequestOptions = {},
    longPollTimeoutMs = 35_000,
  ): Promise<GetUpdatesResponse> {
    return this.request<GetUpdatesResponse>(
      'POST',
      '/ilink/bot/getupdates',
      {
        get_updates_buf: cursor,
        base_info: this.#baseInfo(),
      },
      { ...options, timeoutMs: options.timeoutMs ?? longPollTimeoutMs },
    );
  }

  async sendMessage(body: SendMessageOut, options: RequestOptions = {}): Promise<SendMessageResponse> {
    return this.request<SendMessageResponse>(
      'POST',
      '/ilink/bot/sendmessage',
      { msg: body.msg, base_info: this.#baseInfo() },
      options,
    );
  }

  async getQrCode(localTokenList: string[], options: RequestOptions = {}): Promise<QrCodeResponse> {
    return this.request<QrCodeResponse>(
      'POST',
      '/ilink/bot/get_bot_qrcode?bot_type=3',
      { local_token_list: localTokenList },
      options,
    );
  }

  async getQrCodeStatus(
    qrcode: string,
    verifyCode?: string,
    options: RequestOptions = {},
  ): Promise<QrStatusResponse> {
    let endpoint = `/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
    if (verifyCode !== undefined && verifyCode.length > 0) {
      endpoint += `&verify_code=${encodeURIComponent(verifyCode)}`;
    }
    return this.request<QrStatusResponse>(
      'GET',
      endpoint,
      undefined,
      { ...options, timeoutMs: options.timeoutMs ?? 35_000 },
    );
  }

  async getConfig(
    ilinkUserId: string,
    contextToken?: string,
    options: RequestOptions = {},
  ): Promise<GetConfigResponse> {
    return this.request<GetConfigResponse>(
      'POST',
      '/ilink/bot/getconfig',
      { ilink_user_id: ilinkUserId, context_token: contextToken, base_info: this.#baseInfo() },
      options,
    );
  }

  async sendTyping(
    ilinkUserId: string,
    typingTicket: string,
    status: 1 | 2,
    options: RequestOptions = {},
  ): Promise<SendTypingResponse> {
    return this.request<SendTypingResponse>(
      'POST',
      '/ilink/bot/sendtyping',
      { ilink_user_id: ilinkUserId, typing_ticket: typingTicket, status, base_info: this.#baseInfo() },
      options,
    );
  }

  async notifyStart(options: RequestOptions = {}): Promise<NotifyResponse> {
    return this.request<NotifyResponse>('POST', '/ilink/bot/msg/notifystart', { base_info: this.#baseInfo() }, options);
  }

  async notifyStop(options: RequestOptions = {}): Promise<NotifyResponse> {
    return this.request<NotifyResponse>('POST', '/ilink/bot/msg/notifystop', { base_info: this.#baseInfo() }, options);
  }
}

/** Official `buildClientVersion`: 0x00MMNNPP from "major.minor.patch". */
export function encodeClientVersion(version: string): number {
  const parts = version.split('.').map((part) => Number.parseInt(part, 10));
  const major = parts[0] ?? 0;
  const minor = parts[1] ?? 0;
  const patch = parts[2] ?? 0;
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff);
}

/** Official `randomWechatUin`: random uint32 → decimal string → base64. */
export function randomWechatUin(): string {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), 'utf-8').toString('base64');
}
