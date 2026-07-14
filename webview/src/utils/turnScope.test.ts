import { describe, expect, it } from 'vitest';
import type { ClaudeMessage, SubagentInfo } from '../types';
import {
  findLatestConversationTurnStart,
  finalizeSubagentsForSettledTurn,
  isTaskNotificationUserMessage,
} from './turnScope';

const userPrompt = (content: string): ClaudeMessage => ({ type: 'user', content } as ClaudeMessage);
const assistant = (content: string): ClaudeMessage => ({ type: 'assistant', content } as ClaudeMessage);

const NOTIFICATION = '<task-notification>\n'
  + '<task-id>w13nrlnlg</task-id>\n'
  + '<status>completed</status>\n'
  + '<summary>Dynamic workflow "bp-perf-verify" finished</summary>\n'
  + '</task-notification>';

describe('isTaskNotificationUserMessage', () => {
  it('detects notifications in string content', () => {
    expect(isTaskNotificationUserMessage(userPrompt(NOTIFICATION))).toBe(true);
  });

  it('detects notifications in raw text blocks', () => {
    const message = {
      type: 'user',
      content: '',
      raw: { content: [{ type: 'text', text: NOTIFICATION }] },
    } as unknown as ClaudeMessage;
    expect(isTaskNotificationUserMessage(message)).toBe(true);
  });

  it('rejects real prompts and assistant messages', () => {
    expect(isTaskNotificationUserMessage(userPrompt('fix the tests please'))).toBe(false);
    expect(isTaskNotificationUserMessage(assistant(NOTIFICATION))).toBe(false);
  });
});

describe('findLatestConversationTurnStart', () => {
  it('does not treat a task-notification as the start of a new turn', () => {
    const messages = [
      userPrompt('run the workflow'),
      assistant('launching'),
      userPrompt(NOTIFICATION),
      assistant('workflow finished, summarizing'),
    ];
    expect(findLatestConversationTurnStart(messages)).toBe(0);
  });

  it('still starts the turn at the latest real prompt', () => {
    const messages = [
      userPrompt('first task'),
      assistant('done'),
      userPrompt('second task'),
      assistant('working'),
    ];
    expect(findLatestConversationTurnStart(messages)).toBe(2);
  });
});

describe('finalizeSubagentsForSettledTurn', () => {
  const running = (id: string, isBackground: boolean): SubagentInfo => ({
    id,
    type: 'general-purpose',
    description: '',
    status: 'running',
    messageIndex: 0,
    isBackground,
  });

  it('completes foreground subagents when the turn settles but keeps background ones running', () => {
    const [foreground, background] = finalizeSubagentsForSettledTurn(
      [running('fg', false), running('bg', true)],
      false,
    );
    expect(foreground.status).toBe('completed');
    expect(background.status).toBe('running');
  });

  it('leaves everything running while streaming', () => {
    const finalized = finalizeSubagentsForSettledTurn([running('fg', false)], true);
    expect(finalized[0].status).toBe('running');
  });
});
