/**
 * Generic message-transport contract.
 *
 * The adapter keeps transport behind this interface so WeChat (MVP) and
 * Feishu (later) can each be bound to their own `(projectId, tabId)` target
 * without touching gateway or binding logic. A transport only carries text;
 * it never owns agent state, credentials or permissions.
 */
export interface InboundMessage {
  readonly messageId: string;
  readonly text: string;
  readonly receivedAt: number;
}

export interface MessageTransport {
  readonly name: string;

  sendText(text: string): Promise<void>;

  onInbound(handler: (message: InboundMessage) => void): () => void;

  close(): Promise<void>;
}
