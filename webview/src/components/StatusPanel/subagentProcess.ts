import type { SubagentHistoryResponse } from '../../types';
import { parseBackgroundLaunch } from '../../utils/backgroundTasks';

export interface SubagentProcessModel {
  notes: string[];
  readFiles: string[];
  toolCalls: Array<{ id: string; name: string; detail?: string }>;
}

/**
 * Result text as it should be shown to the user. Launch confirmations
 * ("Async agent launched successfully. agentId: … (internal ID - do not
 * mention…)") are internal metadata, not a result — hide them entirely.
 * Final reports get internal plumbing stripped: <usage> blocks and the
 * SendMessage continuation hint the CLI appends after the report.
 */
export function sanitizeAgentResultText(text?: string): string | undefined {
  if (!text) return undefined;
  if (parseBackgroundLaunch(text).isBackground) return undefined;
  const cleaned = text
    .replace(/<usage>[\s\S]*?<\/usage>/gi, '')
    .split('\n')
    .filter((line) => !/internal ID - do not mention|Use SendMessage with to:/i.test(line))
    .join('\n')
    .trim();
  return cleaned || undefined;
}

export function formatSubagentDuration(
  totalDurationMs?: number,
  units?: { ms?: string; s?: string },
): string | null {
  if (typeof totalDurationMs !== 'number') return null;
  const msLabel = units?.ms ?? 'ms';
  const sLabel = units?.s ?? 's';
  if (totalDurationMs < 1000) return `${totalDurationMs}${msLabel}`;
  return `${(totalDurationMs / 1000).toFixed(1)}${sLabel}`;
}

function getRawContent(message: unknown): unknown[] {
  if (!message || typeof message !== 'object') return [];
  const raw = message as Record<string, any>;
  const content = raw.message?.content ?? raw.content;
  return Array.isArray(content) ? content : [];
}

function getToolDetail(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const record = input as Record<string, unknown>;
  const filePath = record.file_path ?? record.path;
  if (typeof filePath === 'string') return filePath;
  const command = record.command ?? record.cmd;
  if (typeof command === 'string') return command;
  const pattern = record.pattern;
  if (typeof pattern === 'string') return pattern;
  return undefined;
}

function compactPath(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts.length > 4 ? `…/${parts.slice(-4).join('/')}` : path;
}

function pushUnique(list: string[], value: string) {
  if (!list.includes(value)) list.push(value);
}

export function buildSubagentProcessModel(history?: SubagentHistoryResponse): SubagentProcessModel {
  const model: SubagentProcessModel = { notes: [], readFiles: [], toolCalls: [] };
  if (!history?.success || !Array.isArray(history.messages)) return model;

  history.messages.forEach((message, messageIndex) => {
    const raw = message && typeof message === 'object' ? message as Record<string, any> : {};
    getRawContent(message).forEach((block, blockIndex) => {
      if (!block || typeof block !== 'object') return;
      const item = block as Record<string, any>;
      if (item.type === 'text' && raw.type === 'assistant' && typeof item.text === 'string' && item.text.trim()) {
        model.notes.push(item.text.trim());
        return;
      }
      if (item.type !== 'tool_use') return;

      const name = typeof item.name === 'string' ? item.name : 'Tool';
      const detail = getToolDetail(item.input);
      if (name.toLowerCase() === 'read' && detail) {
        pushUnique(model.readFiles, compactPath(detail));
        return;
      }
      model.toolCalls.push({
        id: `${messageIndex}-${blockIndex}`,
        name,
        detail: detail ? compactPath(detail) : undefined,
      });
    });
  });

  return model;
}
