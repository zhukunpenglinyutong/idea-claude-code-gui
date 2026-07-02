import { canUseTool, requestPlanApproval, SAFE_ALWAYS_ALLOW_TOOLS, EDIT_TOOLS, EXECUTION_TOOLS } from '../../permission-handler.js';
import { debugLog } from '../../permission-ipc.js';

/**
 * Plan mode allowed tools.
 * In plan mode, only read-only/exploration tools and specific planning tools are allowed.
 * Write/Edit/Bash are NOT in this list — they go through canUseTool for explicit permission.
 *
 * Matches CLI behavior:
 * - SAFE_ALWAYS_ALLOW_TOOLS are auto-approved (handled before this check)
 * - WebFetch/WebSearch are allowed for exploration (read-only in practice)
 * - Write/Edit require canUseTool (plan file writes only)
 * - Bash requires canUseTool
 * - ExitPlanMode triggers plan approval dialog
 */
const PLAN_MODE_ALLOWED_TOOLS = new Set([
  // Read-only tools (not in SAFE_ALWAYS_ALLOW_TOOLS but safe for exploration)
  'WebFetch', 'WebSearch',
  // MCP read-only
  'ListMcpResources', 'ListMcpResourcesTool',
  'ReadMcpResource', 'ReadMcpResourceTool',
  // Specific MCP tools commonly used in exploration
  'mcp__ace-tool__search_context',
  'mcp__context7__resolve-library-id',
  'mcp__context7__query-docs',
  'mcp__conductor__GetWorkspaceDiff',
  'mcp__conductor__GetTerminalOutput',
  'mcp__conductor__AskUserQuestion',
  'mcp__conductor__DiffComment',
  'mcp__time__get_current_time',
  'mcp__time__convert_time',
]);

const PLAN_FILE_NAME = 'PLAN.md';

function isPlanFilePath(filePath, cwd) {
  if (!filePath || typeof filePath !== 'string') return false;
  const workingDir = cwd || process.cwd();
  // Normalize separators but preserve case for directory comparison (Linux is case-sensitive)
  const normalizedPath = filePath.replace(/\\/g, '/');
  const normalizedCwd = workingDir.replace(/\\/g, '/');
  // Only compare filename case-insensitively (PLAN.md, plan.md, Plan.md are all valid)
  const fileName = normalizedPath.split('/').pop() || '';
  if (fileName.toLowerCase() !== 'plan.md') return false;
  // Check if the file is in the project root (CWD)
  if (normalizedPath.startsWith(normalizedCwd + '/') || normalizedPath.startsWith(normalizedCwd)) return true;
  if (!normalizedPath.includes('/')) return true; // Relative path like "PLAN.md"
  return false;
}

/**
 * Extract all file paths from a tool's input.
 * MultiEdit may have multiple edits targeting different files.
 */
function extractFilePaths(toolName, toolInput) {
  if (!toolInput) return [];
  if (toolName === 'MultiEdit' && Array.isArray(toolInput.edits)) {
    return toolInput.edits
      .map(e => e.file_path || e.path)
      .filter(Boolean);
  }
  const fp = toolInput.file_path || toolInput.path;
  return fp ? [fp] : [];
}

const INTERACTIVE_TOOLS = new Set(['AskUserQuestion']);
const VALID_PERMISSION_MODES = new Set(['default', 'plan', 'acceptEdits', 'bypassPermissions']);

// Yield to the SDK's native permission flow (settings.json deny/allow/ask rules,
// mode-check, canUseTool fallback). Maps to SyncHookJSONOutput.continue in sdk.d.ts.
// Frozen so accidental mutation cannot leak across hook invocations.
const YIELD_TO_SDK = Object.freeze({ continue: true });

export {
  PLAN_MODE_ALLOWED_TOOLS,
  INTERACTIVE_TOOLS,
  VALID_PERMISSION_MODES,
  YIELD_TO_SDK
};

export function normalizePermissionMode(permissionMode) {
  if (!permissionMode || permissionMode === '') return 'default';
  if (VALID_PERMISSION_MODES.has(permissionMode)) return permissionMode;
  console.warn('[DAEMON] Unknown permission mode, falling back to default:', permissionMode);
  return 'default';
}

export function createPreToolUseHook(permissionModeState, cwd = null, onModeChange = null) {
  const workingDirectory = cwd || process.cwd();
  const readPermissionMode = () => {
    if (permissionModeState && typeof permissionModeState === 'object') {
      const normalized = normalizePermissionMode(permissionModeState.value);
      if (permissionModeState.value !== normalized) {
        permissionModeState.value = normalized;
      }
      return normalized;
    }
    return normalizePermissionMode(permissionModeState);
  };
  const updatePermissionMode = async (mode) => {
    const normalized = normalizePermissionMode(mode);
    if (permissionModeState && typeof permissionModeState === 'object') {
      permissionModeState.value = normalized;
    }
    if (typeof onModeChange === 'function') {
      await onModeChange(normalized);
    }
    return normalized;
  };

  return async (input) => {
    let currentPermissionMode = readPermissionMode();
    const toolName = input?.tool_name;

    debugLog('PERMISSION_HOOK', `Called for tool: ${toolName}, mode: ${currentPermissionMode}`);

    // ======== HANDLE EnterPlanMode - update permissionModeState ========
    // When EnterPlanMode is called, we need to switch to plan mode for subsequent tools
    if (toolName === 'EnterPlanMode') {
      debugLog('PERMISSION_HOOK', 'EnterPlanMode called, switching to plan mode');
      currentPermissionMode = await updatePermissionMode('plan');
      // Auto-allow EnterPlanMode (it's in SAFE_ALWAYS_ALLOW_TOOLS)
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow'
        }
      };
    }

    // ======== PLAN MODE ========
    if (currentPermissionMode === 'plan') {
      // Step 1: ExitPlanMode triggers plan approval dialog (must check BEFORE safe tools
      // because ExitPlanMode is in SAFE_ALWAYS_ALLOW_TOOLS but needs special handling here)
      if (toolName === 'ExitPlanMode') {
        try {
          const result = await requestPlanApproval(input?.tool_input);
          if (result?.approved) {
            const nextMode = result.targetMode || 'default';
            currentPermissionMode = await updatePermissionMode(nextMode);
            return {
              hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: 'allow',
                updatedInput: {
                  ...input.tool_input,
                  approved: true,
                  targetMode: nextMode
                }
              }
            };
          }
          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny'
            },
            reason: result?.message || 'Plan was rejected by user'
          };
        } catch (error) {
          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny'
            },
            reason: 'Plan approval failed: ' + (error?.message || String(error))
          };
        }
      }

      // Step 2: Safe always-allow tools yield to SDK so settings.json deny rules can fire.
      if (SAFE_ALWAYS_ALLOW_TOOLS.has(toolName)) {
        return YIELD_TO_SDK;
      }

      // Step 3: Agent/Task are auto-approved in plan mode, matching CLI behavior.
      if (toolName === 'Agent' || toolName === 'Task') {
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'allow'
          }
        };
      }

      // Step 4: Edit/Write tools allow PLAN.md only; other writes require permission.
      if (toolName === 'Edit' || toolName === 'Write' || toolName === 'MultiEdit' ||
          toolName === 'NotebookEdit') {
        // MultiEdit may contain multiple file paths — check ALL of them
        const filePaths = extractFilePaths(toolName, input?.tool_input);
        const allArePlanFiles = filePaths.length > 0 &&
          filePaths.every(fp => isPlanFilePath(fp, workingDirectory));
        if (allArePlanFiles) {
          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'allow'
            }
          };
        }
        try {
          const result = await canUseTool(toolName, input?.tool_input);
          if (result?.behavior === 'allow') {
            return {
              hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: 'allow',
                updatedInput: result.updatedInput ?? input?.tool_input
              }
            };
          }
          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny'
            },
            reason: result?.message || `Cannot edit non-plan files in plan mode. Only ${PLAN_FILE_NAME} can be edited.`
          };
        } catch (error) {
          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny'
            },
            reason: 'Permission check failed: ' + (error?.message || String(error))
          };
        }
      }

      if (toolName === 'Bash') {
        try {
          const result = await canUseTool(toolName, input?.tool_input);
          if (result?.behavior === 'allow') {
            return {
              hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: 'allow',
                updatedInput: result.updatedInput ?? input?.tool_input
              }
            };
          }
          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny'
            },
            reason: result?.message || 'Permission denied'
          };
        } catch (error) {
          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny'
            },
            reason: 'Permission check failed: ' + (error?.message || String(error))
          };
        }
      }

      // Step 5: Plan mode specific allowed tools (read-only exploration tools)
      if (PLAN_MODE_ALLOWED_TOOLS.has(toolName)) {
        return YIELD_TO_SDK;
      }

      // Step 6: Auto-approve read-only MCP tools (mcp__* without Write/Edit in name)
      if (toolName?.startsWith('mcp__') && !toolName.includes('Write') && !toolName.includes('Edit')) {
        return YIELD_TO_SDK;
      }

      // Everything else is blocked in plan mode
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny'
        },
        reason: `Tool "${toolName}" is not allowed in plan mode. Only read-only tools are permitted.`
      };
    }

    // ======== DEFAULT MODE ========
    // Read-only / inherently-safe tools yield to the SDK so that settings.json DENY rules
    // (e.g. deny Read(./.env)) still apply; an allow-rule for a read-only tool is harmless.
    // Every other tool (Bash, Write/Edit, Agent, write-capable MCP, …) is forced through
    // our own canUseTool gate via a hook 'ask' decision, which OVERRIDES any allow-rule in
    // a project/local .claude/settings.json (attacker-controllable when a malicious repo is
    // opened). This closes the silent-auto-approve path without weakening deny-rules.
    if (currentPermissionMode === 'default') {
      const isReadOnlyMcp = toolName?.startsWith('mcp__')
        && !toolName.includes('Write') && !toolName.includes('Edit');
      if (SAFE_ALWAYS_ALLOW_TOOLS.has(toolName) || isReadOnlyMcp) {
        return YIELD_TO_SDK;
      }
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'ask',
          permissionDecisionReason: 'Default mode: settings.json allow-rules are not honored for this tool; explicit confirmation required.'
        }
      };
    }

    // ======== acceptEdits MODE ========
    // acceptEdits auto-accepts FILE EDITS only. Command execution (Bash) and sub-agent
    // launches (Agent) must still be confirmed and must NOT be auto-approved by a project
    // allow-rule, so route them through canUseTool via 'ask'. Edits fall through to the
    // SDK's native acceptEdits handling below.
    if (currentPermissionMode === 'acceptEdits' && EXECUTION_TOOLS.has(toolName)) {
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'ask',
          permissionDecisionReason: 'acceptEdits mode: command execution still requires explicit confirmation.'
        }
      };
    }

    // acceptEdits (file edits) and bypassPermissions yield to the SDK's native flow.
    return YIELD_TO_SDK;
  };
}
