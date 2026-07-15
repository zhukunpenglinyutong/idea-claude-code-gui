import { describe, expect, it } from 'vitest';
import type { ClaudeMessage, SubagentInfo } from '../types';
import {
  BACKGROUND_TURN_FRESHNESS_MS,
  findLatestConversationTurnStart,
  finalizeSubagentsForSettledTurn,
  getBackgroundTurnActivity,
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

describe('getBackgroundTurnActivity', () => {
  const NOW = Date.parse('2026-07-14T23:00:30.000Z');
  const notificationAt = (iso: string): ClaudeMessage => ({
    type: 'user',
    content: NOTIFICATION,
    raw: { type: 'queue-operation', content: NOTIFICATION, timestamp: iso },
  } as unknown as ClaudeMessage);

  it('is active while a fresh notification is the last message', () => {
    const activity = getBackgroundTurnActivity(
      [userPrompt('start'), assistant('launched'), notificationAt('2026-07-14T23:00:10.000Z')],
      NOW,
    );
    expect(activity.active).toBe(true);
    expect(activity.startTimeMs).toBe(Date.parse('2026-07-14T23:00:10.000Z'));
  });

  it('goes inactive once the assistant reply lands after the notification', () => {
    const messages = [
      userPrompt('start'),
      notificationAt('2026-07-14T23:00:10.000Z'),
      assistant('the background task finished, here is the summary'),
    ];
    expect(getBackgroundTurnActivity(messages, NOW).active).toBe(false);
  });

  it('ignores stale notifications (session died before responding)', () => {
    const stale = notificationAt('2026-07-14T20:00:00.000Z');
    expect(NOW - Date.parse('2026-07-14T20:00:00.000Z')).toBeGreaterThan(BACKGROUND_TURN_FRESHNESS_MS);
    expect(getBackgroundTurnActivity([userPrompt('start'), stale], NOW).active).toBe(false);
  });

  it('treats a missing timestamp as fresh (live-streamed message)', () => {
    const noTs = { type: 'user', content: NOTIFICATION } as ClaudeMessage;
    expect(getBackgroundTurnActivity([noTs], NOW)).toEqual({ active: true });
  });

  it('is inactive for ordinary prompts and empty transcripts', () => {
    expect(getBackgroundTurnActivity([], NOW).active).toBe(false);
    expect(getBackgroundTurnActivity([userPrompt('hello')], NOW).active).toBe(false);
  });
});
