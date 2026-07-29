/**
 * Tool name constants for consistent tool identification across the application.
 * Centralizes tool name definitions to prevent inconsistencies.
 */

// Read/file viewing tools
export const READ_TOOL_NAMES = new Set(['read', 'read_file', 'read_multiple_files']);

// Edit/file modification tools
export const EDIT_TOOL_NAMES = new Set(['edit', 'edit_file', 'replace_string', 'write_to_file']);

// Bash/command execution tools
export const BASH_TOOL_NAMES = new Set(['bash', 'run_terminal_cmd', 'exec_command', 'execute_command', 'shell_command']);

// Search/grep/glob tools
export const SEARCH_TOOL_NAMES = new Set(['grep', 'glob', 'search', 'find', 'search_files']);

// Agent/subagent spawning tools. 'workflow' is the ultracode orchestrator tool —
// it fans out many subagents, so it belongs in the agent-style rendering path.
export const AGENT_TOOL_NAMES = new Set(['task', 'agent', 'spawn_agent', 'workflow']);

// Task management tools (new structured Task API)
export const TASK_MANAGE_TOOL_NAMES = new Set(['taskcreate', 'taskupdate', 'taskget', 'tasklist']);

// Internal orchestration tools that may be useful during streaming but should
// not remain as residual tool cards after the final answer is complete.
export const TRANSIENT_INTERNAL_TOOL_NAMES = new Set([
  'list_mcp_resources',
  'list_mcp_resource_templates',
  'read_mcp_resource',
  'parallel',
  'multi_tool_use.parallel',
]);

// File modification tools (for rewind feature - includes write for new file creation)
export const FILE_MODIFY_TOOL_NAMES = new Set([
  'write',
  'write_file',
  'edit',
  'edit_file',
  'replace_string',
  'write_to_file',
  'notebookedit',
  'create_file',
]);

export function normalizeToolName(toolName: string): string {
  const lower = toolName.toLowerCase();
  const mcpMatch = /^mcp__[^_]+__(.+)$/.exec(lower);
  return mcpMatch ? mcpMatch[1] : lower;
}

/**
 * Check if a tool name matches a set of tool names (case-insensitive)
 */
export function isToolName(toolName: string | undefined, toolSet: Set<string>): boolean {
  return toolName !== undefined && toolSet.has(normalizeToolName(toolName));
}

export function isTransientInternalToolName(toolName: string | undefined): boolean {
  if (!toolName) return false;
  const lower = toolName.toLowerCase();
  return TRANSIENT_INTERNAL_TOOL_NAMES.has(lower) || TRANSIENT_INTERNAL_TOOL_NAMES.has(normalizeToolName(lower));
}

/**
 * Whether a content block is a tool_use that renders nothing in the message
 * list (TodoWrite, TaskCreate, update_plan, and transient internal tools once
 * streaming ends). Mirrors the null-return branches in ContentBlockRenderer so
 * callers can filter such blocks before rendering - their arrival otherwise
 * re-renders the message and shifts the streaming thinking block's last-block
 * status, which flickered the thinking block. Pass the message's streaming
 * flag so the transient-internal branch matches the renderer's behavior.
 */
export function isNonRenderedToolUse(
  block: { type?: string; name?: string },
  isStreaming: boolean,
): boolean {
  if (block.type !== 'tool_use') return false;
  const toolName = normalizeToolName(block.name ?? '');
  if (toolName === 'todowrite' || toolName === 'update_plan' || TASK_MANAGE_TOOL_NAMES.has(toolName)) {
    return true;
  }
  if (!isStreaming && isTransientInternalToolName(block.name)) {
    return true;
  }
  return false;
}
