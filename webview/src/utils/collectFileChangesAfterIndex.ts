import type { ClaudeMessage, ClaudeContentBlock, ToolResultBlock } from '../types';
import type { EditOperation } from '../types/fileChanges';
import { FILE_MODIFY_TOOL_NAMES, isToolName, normalizeToolName } from './toolConstants';
import { normalizeToolInput } from './toolInputNormalization';
import {
  extractFilePath,
  extractStrings,
  determineFileStatus,
  isSuccessfulResult,
} from './fileChangeUtils';

export interface UndoFileEntry {
  filePath: string;
  status: 'A' | 'M';
  operations: Array<{
    oldString: string;
    newString: string;
    replaceAll?: boolean;
  }>;
}

/**
 * Collect file changes from messages after a given index.
 *
 * Scans assistant messages starting from `startIndex`, extracts file-modifying
 * tool_use blocks, validates they completed successfully, groups operations by
 * file path, and returns entries ready for `undo_all_file_changes`.
 *
 * @param startIndex - First message index to scan (exclusive: changes AFTER this index)
 * @param messages - Full message array
 * @param getContentBlocks - Extracts content blocks from a message
 * @param findToolResult - Looks up tool result by tool ID and message index
 * @returns File entries sorted by path, with operations in chronological order
 */
export function collectFileChangesAfterIndex(
  startIndex: number,
  messages: ClaudeMessage[],
  getContentBlocks: (message: ClaudeMessage) => ClaudeContentBlock[],
  findToolResult: (toolUseId?: string, messageIndex?: number) => ToolResultBlock | null,
): UndoFileEntry[] {
  // Map to collect operations by file path
  const fileOperationsMap = new Map<string, EditOperation[]>();

  // Iterate through messages starting from startIndex (exclusive)
  for (let messageIndex = startIndex + 1; messageIndex < messages.length; messageIndex += 1) {
    const message = messages[messageIndex];
    if (message.type !== 'assistant') continue;

    const blocks = getContentBlocks(message);

    for (const block of blocks) {
      if (block.type !== 'tool_use') continue;

      const toolName = normalizeToolName(block.name ?? '');

      // Only process file modification tools
      if (!isToolName(toolName, FILE_MODIFY_TOOL_NAMES)) continue;

      const rawInput = block.input as Record<string, unknown> | undefined;
      const input = rawInput
        ? (normalizeToolInput(block.name, rawInput) as Record<string, unknown>)
        : undefined;
      if (!input) continue;

      const filePath = extractFilePath(input);
      if (!filePath) continue;

      // Check if operation completed successfully
      const result = findToolResult(block.id, messageIndex);
      if (!isSuccessfulResult(result)) continue;

      const { oldString, newString, replaceAll } = extractStrings(input);

      const operation: EditOperation = {
        toolName,
        oldString,
        newString,
        additions: 0,
        deletions: 0,
        replaceAll,
      };

      // Group by file path
      const existing = fileOperationsMap.get(filePath) ?? [];
      existing.push(operation);
      fileOperationsMap.set(filePath, existing);
    }
  }

  // Convert map to sorted array
  const entries: UndoFileEntry[] = [];

  fileOperationsMap.forEach((operations, filePath) => {
    const status: 'A' | 'M' = determineFileStatus(operations) === 'A' ? 'A' : 'M';

    entries.push({
      filePath: String(filePath || ''),
      status,
      operations: operations.map((op) => ({
        oldString: op.oldString,
        newString: op.newString,
        replaceAll: op.replaceAll,
      })),
    });
  });

  // Sort: Added files first, then by file path
  entries.sort((a, b) => {
    if (a.status !== b.status) {
      return a.status === 'A' ? -1 : 1;
    }
    return a.filePath.localeCompare(b.filePath);
  });

  return entries;
}
