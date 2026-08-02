import { ILinkClient } from '../ilink/client.js';
import { ILinkApiError, ILinkNetworkError, ILinkRateLimitedError, ILinkTimeoutError, isReauthError } from '../ilink/errors.js';
import { InboxJournal } from '../ilink/journal.js';
import { randomUUID } from 'node:crypto';
import {
  MESSAGE_STATE_FINISH,
  MESSAGE_TYPE_BOT,
  TEXT_ITEM_TYPE,
  isUserTextMessage,
  textOf,
  type InboundRawMessage,
} from '../ilink/types.js';
import type { BotCredentials } from '../ilink/store.js';
import type { InboundMessage, MessageTransport } from '../transport.js';
import { segmentText } from './text.js';

export interface WeixinTransportOptions {
  readonly client: ILinkClient;
  readonly journal: InboxJournal;
  readonly credentials: () => BotCredentials | undefined;
  readonly getContextToken: (botAccountId: string, fromUserId: string) => Promise<string | undefined>;
  readonly setContextToken: (botAccountId: string, fromUserId: string, token: string) => Promise<void>;
  readonly onReauthRequired?: () => void;
  readonly onStatus?: (message: string) => void;
  readonly backoffBaseMs?: number;
  readonly backoffMaxMs?: number;
  readonly pollDelayOnErrorMs?: number;
}

const DEFAULT_BACKOFF_BASE_MS = 2_000;
const DEFAULT_BACKOFF_MAX_MS = 30_000;

function jittered(delayMs: number): number {
  return Math.round(delayMs * (0.8 + Math.random() * 0.4));
}

/**
 * WeChat side of the adapter: long-polls iLink, persists every raw message
 * durably before advancing the cursor, and sends segmented text replies.
 *
 * WeChat disconnect never aborts a CC GUI turn; only explicit Stop does.
 */
export class WeixinTransport implements MessageTransport {
  readonly name = 'weixin';

  readonly #options: WeixinTransportOptions;
  readonly #inboundHandlers = new Set<(message: InboundMessage) => void>();
  #polling = false;
  #stopped = false;
  #controller?: AbortController;
  #failureCount = 0;
  #lastContextToken?: { botAccountId: string; fromUserId: string; token: string };

  constructor(options: WeixinTransportOptions) {
    this.#options = options;
  }

  startPolling(): void {
    if (this.#polling) {
      return;
    }
    this.#polling = true;
    this.#stopped = false;
    void this.#pollLoop();
  }

  async #pollLoop(): Promise<void> {
    while (!this.#stopped) {
      const credentials = this.#options.credentials();
      if (credentials === undefined) {
        await this.#delay(1_000);
        continue;
      }
      const controller = new AbortController();
      this.#controller = controller;
      try {
        const cursor = await this.#options.journal.loadCursor(credentials.botAccountId);
        const response = await this.#options.client.getUpdates(cursor, { signal: controller.signal });
        const messages = response.msgs ?? [];
        const fresh: InboundRawMessage[] = [];
        for (const message of messages) {
          const outcome = await this.#options.journal.appendInbox(credentials.botAccountId, message);
          if (outcome === 'new') {
            fresh.push(message);
          }
        }
        // Cursor advances only after the batch is durable (audit §6).
        if (response.get_updates_buf !== undefined) {
          await this.#options.journal.saveCursor(credentials.botAccountId, response.get_updates_buf);
        }
        for (const message of fresh) {
          await this.#handleInbound(credentials, message);
        }
        this.#failureCount = 0;
      } catch (err) {
        if (this.#stopped) {
          break;
        }
        if (err instanceof ILinkTimeoutError) {
          // Normal long-poll timeout is not an error.
          this.#failureCount = 0;
        } else if (isReauthError(err)) {
          this.#options.onReauthRequired?.();
          this.#options.onStatus?.('微信凭据失效（-14），需要重新扫码授权');
          break;
        } else if (err instanceof ILinkRateLimitedError) {
          this.#failureCount += 1;
          const delayMs = err.retryAfterMs ?? this.#backoffDelay();
          this.#options.onStatus?.(`iLink 限流，${Math.round(delayMs / 1000)} 秒后重试`);
          await this.#delay(delayMs);
          continue;
        } else if (err instanceof ILinkNetworkError || err instanceof ILinkApiError) {
          this.#failureCount += 1;
          await this.#delay(this.#backoffDelay());
          continue;
        } else {
          this.#failureCount += 1;
          await this.#delay(this.#backoffDelay());
          continue;
        }
      }
    }
    this.#polling = false;
  }

  async #handleInbound(credentials: BotCredentials, message: InboundRawMessage): Promise<void> {
    const authorized = credentials.authorizedWeixinUserId;
    if (authorized === undefined || !isUserTextMessage(message, authorized)) {
      return;
    }
    // Refresh the reply-routing token from every inbound message (audit §5.4).
    const contextToken = message.context_token;
    const fromUserId = message.from_user_id;
    if (contextToken !== undefined && fromUserId !== undefined) {
      this.#lastContextToken = {
        botAccountId: credentials.botAccountId,
        fromUserId,
        token: contextToken,
      };
      await this.#options.setContextToken(credentials.botAccountId, fromUserId, contextToken);
    }
    const inbound: InboundMessage = {
      messageId: `${credentials.botAccountId}:${message.message_id}`,
      text: textOf(message),
      receivedAt: Date.now(),
    };
    for (const handler of [...this.#inboundHandlers]) {
      handler(inbound);
    }
  }

  async sendText(text: string): Promise<void> {
    const credentials = this.#options.credentials();
    if (credentials === undefined) {
      throw new ILinkApiError(0, 'No authorized bot credentials');
    }
    const fromUserId = credentials.authorizedWeixinUserId;
    if (fromUserId === undefined) {
      throw new ILinkApiError(0, 'No authorized WeChat user');
    }
    const contextToken =
      this.#lastContextToken?.botAccountId === credentials.botAccountId
        ? this.#lastContextToken.token
        : await this.#options.getContextToken(credentials.botAccountId, fromUserId);
    if (contextToken === undefined) {
      throw new ILinkApiError(0, 'No context token: user must send a message first');
    }
    const chunks = segmentText(text);
    for (const chunk of chunks) {
      const response = await this.#options.client.sendMessage({
        msg: {
          from_user_id: '',
          to_user_id: fromUserId,
          client_id: randomUUID(),
          message_type: MESSAGE_TYPE_BOT,
          message_state: MESSAGE_STATE_FINISH,
          context_token: contextToken,
          item_list: [{ type: TEXT_ITEM_TYPE, text_item: { text: chunk } }],
        },
      });
      // Official semantics: success when `ret` is absent or 0.
      if (response.ret !== undefined && response.ret !== 0) {
        throw new ILinkApiError(response.ret, response.errmsg ?? `iLink ret=${response.ret}`);
      }
    }
  }

  onInbound(handler: (message: InboundMessage) => void): () => void {
    this.#inboundHandlers.add(handler);
    return () => this.#inboundHandlers.delete(handler);
  }

  stop(): void {
    this.#stopped = true;
    this.#controller?.abort();
    this.#controller = undefined;
  }

  async close(): Promise<void> {
    this.stop();
  }

  #backoffDelay(): number {
    const base = this.#options.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
    const max = this.#options.backoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS;
    const exponent = Math.min(this.#failureCount - 1, 4);
    return Math.min(base * 2 ** exponent, max);
  }

  async #delay(ms: number): Promise<void> {
    if (ms <= 0) {
      return;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, jittered(ms));
      // Do not let a stopped transport keep the event loop alive.
      const stopWatch = setInterval(() => {
        if (this.#stopped) {
          clearTimeout(timer);
          clearInterval(stopWatch);
          resolve();
        }
      }, 50);
      timer.unref?.();
      stopWatch.unref?.();
    });
  }
}
