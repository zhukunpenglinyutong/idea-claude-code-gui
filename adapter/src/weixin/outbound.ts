import type { SseEnvelope } from '../gateway/sse.js';

export interface OutboundRouterOptions {
  readonly sendText: (text: string) => Promise<void>;
  readonly log?: (message: string) => void;
}

/** Replay chunks shorter than this are never treated as prefix replays. */
const MIN_REPLAY_PREFIX_LEN = 16;

/**
 * Maps frozen Gateway SSE events to user-visible WeChat messages (audit §8).
 *
 * assistant.content is buffered per taskId and sent once at terminal, so a
 * long-running task does not flood WeChat and the final answer is not split
 * into deltas.
 */
export class OutboundRouter {
  readonly #options: OutboundRouterOptions;
  readonly #buffers = new Map<string, string[]>();
  readonly #accepted = new Set<string>();

  constructor(options: OutboundRouterOptions) {
    this.#options = options;
  }

  async handle(envelope: SseEnvelope): Promise<void> {
    const taskId = envelope.taskId;
    switch (envelope.event) {
      case 'task.accepted': {
        if (taskId !== undefined && !this.#accepted.has(taskId)) {
          this.#accepted.add(taskId);
          await this.#options.sendText('已收到，正在处理…');
        }
        break;
      }
      case 'assistant.content': {
        if (taskId !== undefined) {
          const text = String(envelope.payload.text ?? '');
          this.#options.log?.(
            `assistant.content task=${taskId} eventId=${envelope.eventId} len=${text.length} ` +
              `head=${JSON.stringify(text.slice(0, 40))}`,
          );
          if (text.length > 0) {
            const buffer = this.#buffers.get(taskId) ?? [];
            const isReplay = buffer.some((previous) => {
              if (previous === text) {
                return true;
              }
              return (
                text.length >= MIN_REPLAY_PREFIX_LEN &&
                text.length < previous.length &&
                (previous.startsWith(text) || previous.endsWith(text))
              );
            });
            if (isReplay) {
              this.#options.log?.(
                `replay-skip task=${taskId} eventId=${envelope.eventId} len=${text.length} ` +
                  `head=${JSON.stringify(text.slice(0, 40))}`,
              );
            } else {
              buffer.push(text);
              this.#buffers.set(taskId, buffer);
            }
          }
        }
        break;
      }
      case 'task.completed': {
        await this.#flushAndSend(taskId);
        break;
      }
      case 'task.failed': {
        const unresolved = Boolean(envelope.payload.unresolvedInteractions);
        await this.#flushAndSend(
          taskId,
          `任务失败${unresolved ? '（存在未处理的交互请求）' : ''}。`,
        );
        break;
      }
      case 'task.aborted': {
        await this.#flushAndSend(taskId, '任务已停止。');
        break;
      }
      case 'permission.requested': {
        const interactionId = String(envelope.payload.interactionId ?? '');
        const toolName = String(envelope.payload.toolName ?? '工具');
        const preview = formatPermissionPreview(envelope.payload.inputs);
        await this.#options.sendText(
          `需要授权（${interactionId}）：${toolName}。` +
            `${preview === '' ? '' : `\n${preview}`}` +
            `\n请回复：允许 / 始终允许 / 拒绝（或 ALLOW / ALLOW_ALWAYS / DENY，对应桌面 Apply Always / Apply / Reject）。` +
            `\n注意：「始终允许」将不再询问此工具。`,
        );
        break;
      }
      case 'question.requested': {
        const interactionId = String(envelope.payload.interactionId ?? '');
        await this.#options.sendText(`需要回答（${interactionId}）：请直接回复答案。`);
        break;
      }
      case 'plan.requested': {
        const interactionId = String(envelope.payload.interactionId ?? '');
        await this.#options.sendText(`需要批准计划（${interactionId}）：回复 同意 或 拒绝。`);
        break;
      }
      case 'stream.overflow': {
        await this.#options.sendText('事件流过载，连接已断开，请稍后重试。');
        break;
      }
      default:
        break;
    }
  }

  async #flushAndSend(taskId: string | undefined, fallback?: string): Promise<void> {
    if (taskId === undefined) {
      if (fallback !== undefined) {
        await this.#options.sendText(fallback);
      }
      return;
    }
    this.#accepted.delete(taskId);
    const buffer = this.#buffers.get(taskId);
    if (buffer !== undefined && buffer.length > 0) {
      this.#buffers.delete(taskId);
      const joined = buffer.join('');
      this.#options.log?.(
        `flush task=${taskId} chunks=${buffer.length} joinedLen=${joined.length} ` +
          `head=${JSON.stringify(joined.slice(0, 40))} tail=${JSON.stringify(joined.slice(-40))}`,
      );
      await this.#options.sendText(joined);
      return;
    }
    if (fallback !== undefined) {
      await this.#options.sendText(fallback);
    }
  }

  reset(): void {
    this.#buffers.clear();
    this.#accepted.clear();
  }
}

/**
 * Renders a compact, human-readable preview of a permission request so the
 * WeChat user can approve with informed consent (E2E-P2-009). Falls back to a
 * truncated JSON dump when no well-known field is present.
 */
function formatPermissionPreview(inputs: unknown): string {
  if (inputs === null || inputs === undefined || typeof inputs !== 'object') {
    return '';
  }
  const obj = inputs as Record<string, unknown>;
  const command = obj.command ?? obj.commandLine ?? obj.cmd;
  if (typeof command === 'string' && command.trim().length > 0) {
    return `命令：${command.trim()}`;
  }
  const path = obj.path ?? obj.filePath ?? obj.file_path;
  if (typeof path === 'string' && path.trim().length > 0) {
    return `路径：${path.trim()}`;
  }
  let raw: string;
  try {
    raw = JSON.stringify(inputs);
  } catch {
    return '';
  }
  if (raw === undefined || raw.length === 0 || raw === '{}') {
    return '';
  }
  const max = 600;
  if (raw.length > max) {
    return `内容：${raw.slice(0, max)}…（内容过长已省略，完整内容见桌面弹窗）`;
  }
  return `内容：${raw}`;
}
