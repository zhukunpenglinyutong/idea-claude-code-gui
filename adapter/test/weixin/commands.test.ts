import { describe, expect, it } from 'vitest';
import { parseUserCommand } from '../../src/weixin/commands.js';
import type { PendingInteraction } from '../../src/weixin/interactions.js';

const PERMISSION: PendingInteraction = {
  interactionId: 'i1',
  taskId: 't1',
  kind: 'permission',
  askedAt: 1,
};

const PLAN: PendingInteraction = {
  interactionId: 'i2',
  taskId: 't1',
  kind: 'plan',
  askedAt: 2,
};

const QUESTION: PendingInteraction = {
  interactionId: 'i3',
  taskId: 't1',
  kind: 'question',
  askedAt: 3,
};

describe('parseUserCommand', () => {
  it('recognises exact stop words', () => {
    for (const word of ['stop', '停止', '停', 'abort', '终止', ' STOP ']) {
      expect(parseUserCommand(word).type).toBe('stop');
    }
  });

  it('never treats mid-sentence text as stop', () => {
    expect(parseUserCommand('不要停止，继续').type).toBe('chat');
  });

  it('maps permission replies when a permission is pending', () => {
    expect(parseUserCommand('允许', PERMISSION)).toEqual({ type: 'permission', decision: 'ALLOW' });
    expect(parseUserCommand('ALLOW_ALWAYS', PERMISSION)).toEqual({
      type: 'permission',
      decision: 'ALLOW_ALWAYS',
    });
    expect(parseUserCommand('拒绝', PERMISSION)).toEqual({ type: 'permission', decision: 'DENY' });
  });

  it('falls back to chat for permission words without a pending permission', () => {
    expect(parseUserCommand('允许').type).toBe('chat');
    expect(parseUserCommand('allow', PLAN).type).toBe('chat');
  });

  it('maps plan replies when a plan is pending', () => {
    expect(parseUserCommand('同意', PLAN)).toEqual({ type: 'plan', approved: true });
    expect(parseUserCommand('拒绝', PLAN)).toEqual({ type: 'plan', approved: false });
  });

  it('treats any text as the question answer while a question is pending', () => {
    expect(parseUserCommand(' 我的答案是 A ', QUESTION)).toEqual({
      type: 'question',
      text: '我的答案是 A',
    });
  });

  it('falls back to chat for everything else', () => {
    expect(parseUserCommand('继续刚才的工作', PERMISSION)).toEqual({
      type: 'chat',
      text: '继续刚才的工作',
    });
    expect(parseUserCommand('')).toEqual({ type: 'chat', text: '' });
  });
});
