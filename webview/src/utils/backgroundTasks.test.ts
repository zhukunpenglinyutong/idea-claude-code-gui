import { describe, expect, it } from 'vitest';
import type { ClaudeMessage } from '../types';
import {
  collectFinishedBackgroundTasks,
  getFinishedBackgroundTaskStatus,
  parseBackgroundLaunch,
} from './backgroundTasks';

// Real launch-confirmation texts as emitted by the CLI.
const AGENT_LAUNCH_TEXT = 'Async agent launched successfully.\n'
  + "agentId: a01c596b617a75624 (internal ID - do not mention to user. Use SendMessage with to: 'a01c596b617a75624', summary: '<5-10 word recap>' to continue this agent.)\n"
  + 'The agent is working in the background.';

const WORKFLOW_LAUNCH_TEXT = 'Workflow launched in background. Task ID: w057006cy\n'
  + 'Summary: Multi-agent architecture review\n'
  + 'Transcript dir: /Users/me/.claude/projects/-proj/140f4cf2/subagents/workflows/wf_b0810326-40da';

// Real task-notification appended to the transcript when the task ends.
const NOTIFICATION_TEXT = '<task-notification>\n'
  + '<task-id>a01c596b617a75624</task-id>\n'
  + '<tool-use-id>toolu_01KfcSbbqTc2EARfgXUmn1ck</tool-use-id>\n'
  + '<output-file>/tmp/tasks/a01c596b617a75624.output</output-file>\n'
  + '<status>completed</status>\n'
  + '<summary>Agent "FE portalStatus filters" finished</summary>\n'
  + '</task-notification>';

describe('parseBackgroundLaunch', () => {
  it('detects an async Agent launch and extracts the agent id', () => {
    const launch = parseBackgroundLaunch(AGENT_LAUNCH_TEXT);
    expect(launch.isBackground).toBe(true);
    expect(launch.agentId).toBe('a01c596b617a75624');
  });

  it('detects a background Workflow launch and extracts the task id', () => {
    const launch = parseBackgroundLaunch(WORKFLOW_LAUNCH_TEXT);
    expect(launch.isBackground).toBe(true);
    expect(launch.taskId).toBe('w057006cy');
  });

  it('treats a normal final report as foreground', () => {
    expect(parseBackgroundLaunch('Refactoring done, all 12 tests pass.').isBackground).toBe(false);
    expect(parseBackgroundLaunch(undefined).isBackground).toBe(false);
  });

  it('detects a background Bash command and extracts its task id', () => {
    const launch = parseBackgroundLaunch(
      'Command running in background with ID: b06hiiaoj. Output is being written to: '
      + '/private/tmp/claude-501/-proj/d62beab6/tasks/b06hiiaoj.output. You will be notified when it completes.',
    );
    expect(launch.isBackground).toBe(true);
    expect(launch.taskId).toBe('b06hiiaoj');
  });

  it('detects a Monitor start and extracts its task id', () => {
    const launch = parseBackgroundLaunch(
      'Monitor started (task bkvs4037z, timeout 600000ms). You will be notified on each event. '
      + 'Keep working — do not poll or sleep.',
    );
    expect(launch.isBackground).toBe(true);
    expect(launch.taskId).toBe('bkvs4037z');
  });
});

describe('collectFinishedBackgroundTasks', () => {
  it('collects task-id and tool-use-id with status from a content string', () => {
    const messages: ClaudeMessage[] = [
      { type: 'user', content: NOTIFICATION_TEXT } as ClaudeMessage,
    ];
    const finished = collectFinishedBackgroundTasks(messages);
    expect(finished.get('a01c596b617a75624')).toBe('completed');
    expect(finished.get('toolu_01KfcSbbqTc2EARfgXUmn1ck')).toBe('completed');
  });

  it('collects notifications from raw content text blocks and keeps terminal status', () => {
    const failed = NOTIFICATION_TEXT
      .replace('completed', 'failed')
      .replace(/a01c596b617a75624/g, 'w057006cy')
      .replace('toolu_01KfcSbbqTc2EARfgXUmn1ck', 'toolu_013Y92hsEwJxUBXX27WVctMH');
    const messages: ClaudeMessage[] = [
      {
        type: 'user',
        content: '',
        raw: { content: [{ type: 'text', text: failed }] },
      } as unknown as ClaudeMessage,
    ];
    const finished = collectFinishedBackgroundTasks(messages);
    expect(finished.get('w057006cy')).toBe('failed');
    expect(finished.get('toolu_013Y92hsEwJxUBXX27WVctMH')).toBe('failed');
  });

  it('ignores messages without notifications', () => {
    const messages: ClaudeMessage[] = [
      { type: 'assistant', content: 'plain answer' } as ClaudeMessage,
    ];
    expect(collectFinishedBackgroundTasks(messages).size).toBe(0);
  });

  it('ignores status-less notifications (monitor events, agent messages)', () => {
    const monitorEvent = '<task-notification>\n'
      + '<task-id>bkvs4037z</task-id>\n'
      + '<summary>Monitor event: ERROR in deploy.log</summary>\n'
      + '</task-notification>';
    const messages: ClaudeMessage[] = [
      { type: 'user', content: monitorEvent } as ClaudeMessage,
    ];
    expect(collectFinishedBackgroundTasks(messages).size).toBe(0);
  });
});

describe('getFinishedBackgroundTaskStatus', () => {
  const launch = parseBackgroundLaunch(AGENT_LAUNCH_TEXT);

  it('returns undefined while the task still runs', () => {
    expect(getFinishedBackgroundTaskStatus(new Map(), launch, 'toolu_x')).toBeUndefined();
  });

  it('matches by the launching tool_use id', () => {
    const finished = new Map([['toolu_01KfcSbbqTc2EARfgXUmn1ck', 'completed']]);
    expect(getFinishedBackgroundTaskStatus(finished, launch, 'toolu_01KfcSbbqTc2EARfgXUmn1ck')).toBe('completed');
  });

  it('matches by the agent id parsed from the launch text', () => {
    const finished = new Map([['a01c596b617a75624', 'killed']]);
    expect(getFinishedBackgroundTaskStatus(finished, launch, 'toolu_other')).toBe('killed');
  });

  it('never matches a foreground result', () => {
    const finished = new Map([['toolu_x', 'completed']]);
    expect(getFinishedBackgroundTaskStatus(finished, { isBackground: false }, 'toolu_x')).toBeUndefined();
  });
});
