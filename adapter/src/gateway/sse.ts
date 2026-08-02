import { GatewayError, parseErrorBody } from './errors.js';

/** Envelope of a Remote Gateway SSE event (Contract v1 §7.2). */
export interface SseEnvelope {
  readonly eventId: number;
  readonly event: string;
  readonly timestamp: number;
  readonly projectId: string;
  readonly tabId: string;
  readonly taskId?: string;
  readonly sessionId?: string;
  readonly payload: Record<string, unknown>;
}

export interface SseHandlers {
  onEvent?: (envelope: SseEnvelope) => void;
  onComment?: (line: string) => void;
  onOverflow?: (reason: string) => void;
  onError?: (error: GatewayError) => void;
  onClose?: () => void;
}

export interface SseClientOptions {
  readonly url: string;
  readonly token: string;
  readonly fetchImpl?: typeof fetch;
}

export interface FrameHandlers {
  onEvent?: (name: string, data: string) => void;
  onComment?: (line: string) => void;
}

interface PendingFrame {
  event?: string;
  data?: string[];
}

/**
 * Incremental SSE line parser (spec-compliant field semantics).
 *
 * Feed arbitrary chunk boundaries; the parser buffers partial lines and only
 * dispatches on a blank line (or on flush at stream end).
 */
export class SseLineParser {
  #buffer = '';
  #frame: PendingFrame = {};
  #handlers?: FrameHandlers;

  feed(chunk: string, handlers: FrameHandlers): void {
    this.#handlers = handlers;
    this.#buffer += chunk;
    let newline = this.#buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      this.#handleLine(line.replace(/\r$/, ''));
      newline = this.#buffer.indexOf('\n');
    }
  }

  /** Dispatch any trailing event when the stream ends without a blank line. */
  flush(): void {
    if (this.#buffer.length > 0) {
      this.#handleLine(this.#buffer.replace(/\r$/, ''));
      this.#buffer = '';
    }
    this.#dispatch();
  }

  #handleLine(line: string): void {
    if (line === '') {
      this.#dispatch();
      return;
    }
    if (line.startsWith(':')) {
      this.#handlers?.onComment?.(line.slice(1).trim());
      return;
    }
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
    switch (field) {
      case 'event':
        this.#frame.event = value;
        break;
      case 'data':
        (this.#frame.data ??= []).push(value);
        break;
      default:
        // `id`, `retry` and unknown fields are ignored by the adapter.
        break;
    }
  }

  #dispatch(): void {
    const frame = this.#frame;
    this.#frame = {};
    if (frame.event !== undefined && frame.data !== undefined && frame.data.length > 0) {
      this.#handlers?.onEvent?.(frame.event, frame.data.join('\n'));
    }
  }
}

/**
 * SSE client for one `/events` stream.
 *
 * Keepalive comments are surfaced through `onComment` and otherwise ignored;
 * `stream.overflow` is surfaced through `onOverflow` before the gateway
 * closes the stream.
 */
export class SseClient {
  readonly #options: SseClientOptions;
  #closed = false;
  #controller?: AbortController;
  #reader?: ReadableStreamDefaultReader<Uint8Array>;

  constructor(options: SseClientOptions) {
    this.#options = options;
  }

  async open(handlers: SseHandlers): Promise<void> {
    if (this.#closed) {
      throw new GatewayError('invalid', 'SseClient is closed');
    }
    const fetchImpl = this.#options.fetchImpl ?? fetch;
    const controller = new AbortController();
    this.#controller = controller;
    let response: Response;
    try {
      response = await fetchImpl(this.#options.url, {
        method: 'GET',
        headers: {
          Accept: 'text/event-stream',
          Authorization: `Bearer ${this.#options.token}`,
        },
        signal: controller.signal,
      });
    } catch (cause) {
      throw new GatewayError('network', 'Cannot open SSE stream', { cause });
    }
    if (!response.ok || response.body === null) {
      const fallback = `SSE open failed: HTTP ${response.status}`;
      let message = fallback;
      try {
        const parsed = parseErrorBody(await response.text());
        message = parsed.error?.message ?? fallback;
      } catch {
        // Keep the fallback message.
      }
      throw new GatewayError(
        response.status === 401 || response.status === 403 ? 'auth' : 'http',
        message,
        { status: response.status },
      );
    }
    const reader = response.body.getReader();
    this.#reader = reader;
    const decoder = new TextDecoder();
    const parser = new SseLineParser();
    const frameHandlers: FrameHandlers = {
      onEvent: (name, data) => {
        if (name === 'stream.overflow') {
          handlers.onOverflow?.(data);
          return;
        }
        this.#dispatchEvent(name, data, handlers);
      },
      onComment: (line) => handlers.onComment?.(line),
    };
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        parser.feed(decoder.decode(value, { stream: true }), frameHandlers);
      }
      parser.flush();
    } catch (cause) {
      if (this.#closed) {
        handlers.onClose?.();
        return;
      }
      handlers.onError?.(new GatewayError('network', 'SSE stream failed', { cause }));
      return;
    }
    handlers.onClose?.();
  }

  #dispatchEvent(name: string, data: string, handlers: SseHandlers): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch (cause) {
      handlers.onError?.(new GatewayError('invalid', 'SSE event data is not JSON', { cause }));
      return;
    }
    const raw = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Record<string, unknown>;
    handlers.onEvent?.({
      eventId: typeof raw.eventId === 'number' ? raw.eventId : 0,
      event: name,
      timestamp: typeof raw.timestamp === 'number' ? raw.timestamp : 0,
      projectId: typeof raw.projectId === 'string' ? raw.projectId : '',
      tabId: typeof raw.tabId === 'string' ? raw.tabId : '',
      taskId: typeof raw.taskId === 'string' ? raw.taskId : undefined,
      sessionId: typeof raw.sessionId === 'string' ? raw.sessionId : undefined,
      payload:
        typeof raw.payload === 'object' && raw.payload !== null
          ? (raw.payload as Record<string, unknown>)
          : {},
    });
  }

  close(): void {
    this.#closed = true;
    this.#controller?.abort(new GatewayError('invalid', 'SseClient closed'));
    void this.#reader?.cancel().catch(() => undefined);
  }
}
