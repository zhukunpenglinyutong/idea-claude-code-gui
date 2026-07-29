import type { ToolResultBlock } from '../types';
import type { EditOperation, FileChangeStatus } from '../types/fileChanges';
import { normalizeToolName } from './toolConstants';

/** Write tool names that indicate a new file */
export const WRITE_TOOL_NAMES = new Set(['write', 'write_file', 'create_file']);

/**
 * Extract file path from tool input (handles various naming conventions)
 * Ensures the returned value is a string, not an object (e.g., MCP tool path can be an object)
 */
export function extractFilePath(input: Record<string, unknown>): string | null {
  const pathValue = input.path;
  const filePathValue = input.file_path;
  const targetFileValue = input.target_file;
  const targetFileValue2 = input.targetFile;
  const notebookPathValue = input.notebook_path;

  return (
    (typeof input.filePath === 'string' ? input.filePath : undefined) ??
    (typeof filePathValue === 'string' ? filePathValue : undefined) ??
    (typeof pathValue === 'string' ? pathValue : undefined) ??
    (typeof targetFileValue === 'string' ? targetFileValue : undefined) ??
    (typeof targetFileValue2 === 'string' ? targetFileValue2 : undefined) ??
    (typeof notebookPathValue === 'string' ? notebookPathValue : undefined) ??
    null
  );
}

/**
 * Extract old and new strings from tool input
 */
export function extractStrings(input: Record<string, unknown>): {
  oldString: string;
  newString: string;
  replaceAll?: boolean;
} {
  const oldString =
    (typeof input.old_string === 'string' ? input.old_string : undefined) ??
    (typeof input.oldString === 'string' ? input.oldString : undefined) ??
    '';
  const newString =
    (typeof input.new_string === 'string' ? input.new_string : undefined) ??
    (typeof input.newString === 'string' ? input.newString : undefined) ??
    (typeof input.content === 'string' ? input.content : undefined) ?? // Write tool uses 'content'
    '';
  const replaceAll =
    typeof input.replace_all === 'boolean'
      ? input.replace_all
      : typeof input.replaceAll === 'boolean'
        ? input.replaceAll
        : undefined;

  return { oldString, newString, replaceAll };
}

/**
 * Determine file status (A = Added, M = Modified)
 */
export function determineFileStatus(operations: EditOperation[]): FileChangeStatus {
  if (operations.length === 0) return 'M';

  const firstOp = operations[0];
  // Write/create_file tools indicate a new file
  if (WRITE_TOOL_NAMES.has(normalizeToolName(firstOp.toolName))) {
    return 'A';
  }
  // If first operation has empty oldString, it's likely a new file
  if (firstOp.oldString === '' && firstOp.newString !== '') {
    return 'A';
  }
  return 'M';
}

/**
 * Check if a tool result indicates success
 */
export function isSuccessfulResult(result?: ToolResultBlock | null): boolean {
  return result !== undefined && result !== null && result.is_error !== true;
}
