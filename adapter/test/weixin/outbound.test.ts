import { describe, expect, it } from 'vitest';
import type { SseEnvelope } from '../../src/gateway/sse.js';
import { OutboundRouter } from '../../src/weixin/outbound.js';

function envelope(event: string, payload: Record<string, unknown> = {}, taskId = 'task-1'): SseEnvelope {
  return {
    eventId: 1,
    event,
    timestamp: Date.now(),
    projectId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    tabId: '11111111-2222-3333-4444-555555555555',
    taskId,
    sessionId: 's-1',
    payload,
  };
}

describe('OutboundRouter', () => {
  it('acks once per task and sends the joined final answer only', async () => {
    const sent: string[] = [];
    const logs: string[] = [];
    const router = new OutboundRouter({
      sendText: async (text) => {
        sent.push(text);
      },
      log: (message) => logs.push(message),
    });
    await router.handle(envelope('task.accepted'));
    await router.handle(envelope('task.accepted'));
    await router.handle(envelope('assistant.content', { text: 'A' }));
    await router.handle(envelope('assistant.content', { text: 'B' }));
    await router.handle(envelope('task.completed'));
    expect(sent).toEqual(['已收到，正在处理…', 'AB']);
    expect(logs.some((line) => line.includes('assistant.content task=task-1'))).toBe(true);
    expect(logs.some((line) => line.includes('flush task=task-1') && line.includes('joinedLen=2'))).toBe(true);
  });

  it('separates buffers by taskId', async () => {
    const sent: string[] = [];
    const router = new OutboundRouter({
      sendText: async (text) => {
        sent.push(text);
      },
    });
    await router.handle(envelope('assistant.content', { text: 'X' }, 'task-1'));
    await router.handle(envelope('assistant.content', { text: 'Y' }, 'task-2'));
    await router.handle(envelope('task.completed', {}, 'task-1'));
    await router.handle(envelope('task.completed', {}, 'task-2'));
    expect(sent).toEqual(['X', 'Y']);
  });

  it('maps failed/aborted terminals', async () => {
    const sent: string[] = [];
    const router = new OutboundRouter({
      sendText: async (text) => {
        sent.push(text);
      },
    });
    await router.handle(envelope('task.failed', { unresolvedInteractions: true }));
    await router.handle(envelope('task.aborted', {}, 'task-2'));
    expect(sent).toEqual(['任务失败（存在未处理的交互请求）。', '任务已停止。']);
  });

  it('maps interaction requests to actionable prompts', async () => {
    const sent: string[] = [];
    const router = new OutboundRouter({
      sendText: async (text) => {
        sent.push(text);
      },
    });
    await router.handle(envelope('permission.requested', { interactionId: 'i1', toolName: 'Write' }));
    await router.handle(envelope('question.requested', { interactionId: 'i2' }));
    await router.handle(envelope('plan.requested', { interactionId: 'i3' }));
    await router.handle(envelope('stream.overflow', { reason: 'slow' }));
    expect(sent[0]).toContain('ALLOW / ALLOW_ALWAYS / DENY');
    expect(sent[0]).toContain('允许 / 始终允许 / 拒绝');
    expect(sent[0]).toContain('始终允许');
    expect(sent[1]).toContain('i2');
    expect(sent[2]).toContain('i3');
    expect(sent[3]).toContain('事件流过载');
  });

  it('includes a human-readable command preview in permission prompts', async () => {
    const sent: string[] = [];
    const router = new OutboundRouter({
      sendText: async (text) => {
        sent.push(text);
      },
    });
    await router.handle(
      envelope('permission.requested', {
        interactionId: 'i1',
        toolName: 'Bash',
        inputs: { command: 'python -c "print(1)"' },
      }),
    );
    expect(sent[0]).toContain('命令：python -c "print(1)"');
  });

  it('includes a file path preview for Write permissions', async () => {
    const sent: string[] = [];
    const router = new OutboundRouter({
      sendText: async (text) => {
        sent.push(text);
      },
    });
    await router.handle(
      envelope('permission.requested', {
        interactionId: 'i1',
        toolName: 'Write',
        inputs: { path: 'D:\\tmp\\demo.txt', content: 'hello' },
      }),
    );
    expect(sent[0]).toContain('路径：D:\\tmp\\demo.txt');
  });

  it('ignores delta events that are not user-visible', async () => {
    const sent: string[] = [];
    const router = new OutboundRouter({
      sendText: async (text) => {
        sent.push(text);
      },
    });
    await router.handle(envelope('task.started'));
    await router.handle(envelope('usage.updated', { usedTokens: 1, maxTokens: 1000 }));
    await router.handle(envelope('tool.started', { toolUseId: 't1', tool: 'Read' }));
    expect(sent).toEqual([]);
  });

  it('skips replay chunks that are exact duplicates or prefixes of earlier chunks', async () => {
    const sent: string[] = [];
    const logs: string[] = [];
    const router = new OutboundRouter({
      sendText: async (text) => {
        sent.push(text);
      },
      log: (message) => logs.push(message),
    });
    const full = 'a'.repeat(300);
    await router.handle(envelope('assistant.content', { text: full }));
    await router.handle(envelope('assistant.content', { text: full.slice(0, 57) }));
    await router.handle(envelope('assistant.content', { text: full }));
    await router.handle(envelope('task.completed'));
    expect(sent).toEqual([full]);
    expect(logs.filter((line) => line.includes('replay-skip')).length).toBe(2);
  });

  it('skips replay chunks that are suffixes of earlier chunks', async () => {
    const sent: string[] = [];
    const logs: string[] = [];
    const router = new OutboundRouter({
      sendText: async (text) => {
        sent.push(text);
      },
      log: (message) => logs.push(message),
    });
    const full = 'a'.repeat(300);
    await router.handle(envelope('assistant.content', { text: full }));
    await router.handle(envelope('assistant.content', { text: full.slice(full.length - 57) }));
    await router.handle(envelope('task.completed'));
    expect(sent).toEqual([full]);
    expect(logs.filter((line) => line.includes('replay-skip')).length).toBe(1);
  });

  it('keeps legitimate short chunks and non-overlapping chunks', async () => {
    const sent: string[] = [];
    const router = new OutboundRouter({
      sendText: async (text) => {
        sent.push(text);
      },
    });
    await router.handle(envelope('assistant.content', { text: 'ABCDEFGHIJKLMNOPQRST' }));
    await router.handle(envelope('assistant.content', { text: 'AB' }));
    await router.handle(envelope('assistant.content', { text: 'XYZ' }));
    await router.handle(envelope('task.completed'));
    expect(sent).toEqual(['ABCDEFGHIJKLMNOPQRSTABXYZ']);
  });
});
