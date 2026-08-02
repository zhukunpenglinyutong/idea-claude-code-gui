import type { TargetBinding } from './binding.js';
import { AdapterApp, NotBoundError } from './app.js';
import { GatewayError } from './gateway/errors.js';
import type { SseClient } from './gateway/sse.js';
import type { InboxJournal } from './ilink/journal.js';
import type { InboundMessage, MessageTransport } from './transport.js';
import { looksLikeCommandReply, parseUserCommand } from './weixin/commands.js';
import { InteractionRegistry } from './weixin/interactions.js';
import type { OutboundRouter } from './weixin/outbound.js';

export interface AdapterRuntimeOptions {
  readonly app: AdapterApp;
  readonly transport: MessageTransport;
  readonly outbound: OutboundRouter;
  readonly sseFactory: (target: TargetBinding) => SseClient | Promise<SseClient>;
  readonly journal?: InboxJournal;
  readonly pendingRecovery?: () => Promise<{ dispatching: number; pending: number }>;
  readonly interactions?: InteractionRegistry;
  readonly reconnectDelayMs?: number;
  readonly log?: (message: string) => void;
}

/**
 * Glue between WeChat inbound, the gateway binding, and SSE outbound.
 *
 * Invariants:
 * - SSE is established while BOUND and torn down on INVALID/OFFLINE/UNBOUND;
 * - inbound messages are only dispatched while BOUND; TAB_BUSY is surfaced as
 *   a status text, never queued (Queue is deferred to Phase 2D);
 * - DISPATCHING intent is journaled before `/chat` so a crash leaves a
 *   recoverable record instead of silently re-executing.
 */
export class AdapterRuntime {
  readonly #options: AdapterRuntimeOptions;
  #sse?: SseClient;
  #sseGeneration = 0;
  readonly #interactions: InteractionRegistry;
  #currentTaskId?: string;
  #staleReplyBudget = 0;
  #unsubscribeState?: () => void;
  #unsubscribeInbound?: () => void;
  #stopped = false;

  constructor(options: AdapterRuntimeOptions) {
    this.#options = options;
    this.#interactions = options.interactions ?? new InteractionRegistry();
  }

  start(): void {
    if (this.#stopped) {
      throw new Error('AdapterRuntime is stopped');
    }
    this.#unsubscribeState = this.#options.app.stateMachine.subscribe((next, prev) => {
      const targetChanged =
        prev.target !== undefined &&
        next.target !== undefined &&
        (prev.target.projectId !== next.target.projectId || prev.target.tabId !== next.target.tabId);
      if (next.state === 'BOUND' && (prev.state !== 'BOUND' || targetChanged)) {
        if (targetChanged) {
          this.#invalidateOnTargetChange();
        }
        void this.#openSse();
      } else if (next.state !== 'BOUND' && prev.state === 'BOUND') {
        this.#closeSse();
      }
    });
    this.#unsubscribeInbound = this.#options.transport.onInbound((message) => {
      void this.#handleInbound(message);
    });
    if (this.#options.app.stateMachine.current.state === 'BOUND') {
      void this.#openSse();
    }
    void this.#warnPendingRecovery();
  }

  async #warnPendingRecovery(): Promise<void> {
    if (this.#options.pendingRecovery === undefined) {
      return;
    }
    try {
      const count = await this.#options.pendingRecovery();
      if (count.dispatching > 0 || count.pending > 0) {
        const parts: string[] = [];
        if (count.dispatching > 0) {
          parts.push(
            `检测到 ${count.dispatching} 条未确认消息（可能已发送）。为防重复执行，请人工核对后再重发。`,
          );
        }
        if (count.pending > 0) {
          parts.push(`另有 ${count.pending} 条已收到但未发送的历史消息，需要重新执行请直接重发。`);
        }
        await this.#options.transport.sendText(
          parts.join(' '),
        );
      }
    } catch (err) {
      this.#options.log?.(`pending recovery check failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async #handleInbound(message: InboundMessage): Promise<void> {
    const state = this.#options.app.state;
    if (state.state !== 'BOUND' || state.target === undefined) {
      await this.#options.transport.sendText(`当前未绑定或目标不可用（${state.state}）。`);
      return;
    }
    if (this.#staleReplyBudget > 0 && looksLikeCommandReply(message.text)) {
      this.#staleReplyBudget -= 1;
      await this.#options.transport.sendText('交互已失效：绑定已切换到其他标签页，原请求请重新发起。');
      return;
    }
    const accountId = message.messageId.split(':')[0] ?? 'unknown';
    const messageId = message.messageId.split(':')[1] ?? message.messageId;
    const markSkipped = (): Promise<void> =>
      this.#options.journal?.setStatus(accountId, messageId, 'SKIPPED') ?? Promise.resolve();
    const permissionPending = this.#interactions.findKind('permission');
    const planPending = this.#interactions.findKind('plan');
    const questionPending = this.#interactions.findKind('question');
    const command = parseUserCommand(message.text, permissionPending ?? planPending ?? questionPending);
    switch (command.type) {
      case 'stop': {
        await markSkipped();
        if (this.#currentTaskId === undefined) {
          await this.#options.transport.sendText('当前没有运行中的任务。');
          return;
        }
        await this.#options.app.abort(state.target.projectId, state.target.tabId, this.#currentTaskId);
        await this.#options.transport.sendText('正在停止任务…');
        return;
      }
      case 'permission': {
        if (permissionPending === undefined) {
          break;
        }
        this.#interactions.take(permissionPending.interactionId);
        try {
          await markSkipped();
          await this.#options.app.resolvePermission(
            state.target.projectId,
            state.target.tabId,
            permissionPending.taskId,
            permissionPending.interactionId,
            command.decision,
          );
          await this.#options.transport.sendText('已发送授权决定。');
        } catch (err) {
          await markSkipped();
          this.#options.log?.(`permission resolve failed: ${err instanceof Error ? err.message : String(err)}`);
          await this.#options.transport.sendText(
            `授权决定发送失败：${this.#controlErrorMessage(err)}`,
          );
        }
        return;
      }
      case 'plan': {
        if (planPending === undefined) {
          break;
        }
        this.#interactions.take(planPending.interactionId);
        try {
          await markSkipped();
          await this.#options.app.decidePlan(
            state.target.projectId,
            state.target.tabId,
            planPending.taskId,
            planPending.interactionId,
            command.approved,
          );
          await this.#options.transport.sendText('已发送计划决定。');
        } catch (err) {
          await markSkipped();
          this.#options.log?.(`plan decision failed: ${err instanceof Error ? err.message : String(err)}`);
          await this.#options.transport.sendText(`计划决定发送失败：${this.#controlErrorMessage(err)}`);
        }
        return;
      }
      case 'question': {
        if (questionPending === undefined) {
          break;
        }
        this.#interactions.take(questionPending.interactionId);
        const questionKeys = Object.keys(questionPending.questions ?? {});
        const key = questionKeys[0] ?? 'answer';
        try {
          await markSkipped();
          await this.#options.app.answerQuestion(
            state.target.projectId,
            state.target.tabId,
            questionPending.taskId,
            questionPending.interactionId,
            { [key]: command.text },
          );
          await this.#options.transport.sendText('已发送回答。');
        } catch (err) {
          await markSkipped();
          this.#options.log?.(`question answer failed: ${err instanceof Error ? err.message : String(err)}`);
          await this.#options.transport.sendText(`回答发送失败：${this.#controlErrorMessage(err)}`);
        }
        return;
      }
      case 'chat': {
        if (permissionPending !== undefined) {
          await markSkipped();
          await this.#options.transport.sendText(
            '未识别授权指令，请回复：允许 / 始终允许 / 拒绝（或 ALLOW / ALLOW_ALWAYS / DENY）。',
          );
          return;
        }
        if (planPending !== undefined) {
          await markSkipped();
          await this.#options.transport.sendText('未识别计划指令，请回复：同意 或 拒绝。');
          return;
        }
        break;
      }
    }
    await this.#options.journal?.setStatus(accountId, messageId, 'DISPATCHING');
    try {
      const result = await this.#options.app.sendMessage(message.text, state.target);
      await this.#options.journal?.setStatus(accountId, messageId, 'DISPATCHED');
      this.#options.log?.(`dispatched taskId=${result.taskId}`);
    } catch (err) {
      await this.#options.journal?.setStatus(accountId, messageId, 'SKIPPED');
      if (err instanceof GatewayError && err.kind === 'busy') {
        await this.#options.transport.sendText('当前会话忙，请稍后再试。');
        return;
      }
      if (err instanceof GatewayError && err.kind === 'network') {
        await this.#options.transport.sendText('无法连接 CCGUI 网关，请检查 IDE 是否运行。');
        return;
      }
      if (err instanceof GatewayError && err.kind === 'not_found') {
        await this.#options.transport.sendText('目标已失效，请重新绑定。');
        return;
      }
      if (err instanceof NotBoundError) {
        await this.#options.transport.sendText('目标已失效，请重新绑定。');
        return;
      }
      this.#options.log?.(`dispatch failed: ${err instanceof Error ? err.message : String(err)}`);
      await this.#options.transport.sendText('发送失败，请稍后再试。');
    }
  }

  #controlErrorMessage(err: unknown): string {
    if (err instanceof GatewayError) {
      if (err.kind === 'not_found') {
        return '交互已失效（任务可能已结束），请重新发起';
      }
      if (err.kind === 'busy') {
        return '当前会话忙，请稍后再试';
      }
      if (err.kind === 'auth' || err.kind === 'network') {
        return '无法连接 CCGUI 网关';
      }
      if (err.code === 'INTERACTION_ALREADY_RESOLVED') {
        return '该请求已被处理（桌面或此前回复已完成），无需重复操作';
      }
      return err.message;
    }
    return err instanceof Error ? err.message : String(err);
  }

  async #openSse(): Promise<void> {
    const state = this.#options.app.state;
    if (state.state !== 'BOUND' || state.target === undefined) {
      return;
    }
    this.#closeSse();
    const generation = ++this.#sseGeneration;
    const client = await this.#options.sseFactory(state.target);
    if (this.#stopped || generation !== this.#sseGeneration) {
      client.close();
      return;
    }
    this.#sse = client;
    void client
      .open({
        onEvent: (envelope) => {
          this.#trackEvent(envelope);
          void this.#options.outbound.handle(envelope).catch((error) => {
            this.#options.log?.(
              `outbound event failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          });
        },
        onOverflow: (reason) => {
          void this.#options.outbound.handle({
            eventId: 0,
            event: 'stream.overflow',
            timestamp: Date.now(),
            projectId: state.target?.projectId ?? '',
            tabId: state.target?.tabId ?? '',
            payload: { reason },
          });
        },
        onError: (error) => {
          this.#options.log?.(`SSE error: ${error.message}`);
          this.#scheduleReconnect(generation);
        },
        onClose: () => {
          this.#scheduleReconnect(generation);
        },
      })
      .catch((error) => {
        this.#options.log?.(`SSE open failed: ${error instanceof Error ? error.message : String(error)}`);
        this.#scheduleReconnect(generation);
      });
  }

  #trackEvent(envelope: {
    event: string;
    taskId?: string;
    payload: Record<string, unknown>;
  }): void {
    if (envelope.event === 'task.accepted' && envelope.taskId !== undefined) {
      this.#currentTaskId = envelope.taskId;
      return;
    }
    if (envelope.event === 'task.completed' || envelope.event === 'task.failed' || envelope.event === 'task.aborted') {
      this.#currentTaskId = undefined;
      if (envelope.taskId !== undefined) {
        this.#interactions.clearForTask(envelope.taskId);
      }
      return;
    }
    const taskId = envelope.taskId;
    if (taskId === undefined) {
      return;
    }
    const askedAt = Date.now();
    if (envelope.event === 'permission.requested') {
      const interactionId = String(envelope.payload.interactionId ?? '');
      if (interactionId.length > 0) {
        this.#interactions.register({
          interactionId,
          taskId,
          kind: 'permission',
          toolName: String(envelope.payload.toolName ?? ''),
          askedAt,
        });
        this.#staleReplyBudget = 0;
      }
      return;
    }
    if (envelope.event === 'question.requested') {
      const interactionId = String(envelope.payload.interactionId ?? '');
      if (interactionId.length > 0) {
        this.#interactions.register({
          interactionId,
          taskId,
          kind: 'question',
          questions: envelope.payload.questions as Record<string, unknown> | undefined,
          askedAt,
        });
        this.#staleReplyBudget = 0;
      }
      return;
    }
    if (envelope.event === 'plan.requested') {
      const interactionId = String(envelope.payload.interactionId ?? '');
      if (interactionId.length > 0) {
        this.#interactions.register({
          interactionId,
          taskId,
          kind: 'plan',
          askedAt,
        });
        this.#staleReplyBudget = 0;
      }
    }
  }

  #invalidateOnTargetChange(): void {
    const invalidated = this.#interactions.clearAll();
    this.#currentTaskId = undefined;
    this.#staleReplyBudget = Math.min(invalidated, 5);
    this.#options.log?.(`rebind: invalidated ${invalidated} pending interaction(s)`);
  }

  #scheduleReconnect(generation: number): void {
    if (this.#stopped || generation !== this.#sseGeneration) {
      return;
    }
    const delayMs = this.#options.reconnectDelayMs ?? 2_000;
    const timer = setTimeout(() => {
      if (!this.#stopped && generation === this.#sseGeneration) {
        void this.#openSse();
      }
    }, delayMs);
    timer.unref?.();
  }

  #closeSse(): void {
    this.#sseGeneration += 1;
    const client = this.#sse;
    this.#sse = undefined;
    client?.close();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#unsubscribeState?.();
    this.#unsubscribeState = undefined;
    this.#unsubscribeInbound?.();
    this.#unsubscribeInbound = undefined;
    this.#closeSse();
  }
}
