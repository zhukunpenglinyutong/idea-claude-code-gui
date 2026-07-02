package com.github.claudecodegui.permission;

import com.google.gson.JsonObject;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Stores remembered permission decisions at tool and tool+input granularity.
 */
class PermissionDecisionStore {

    private final Map<String, Integer> parameterDecisionMemory = new ConcurrentHashMap<>();
    private final Map<String, Boolean> toolDecisionMemory = new ConcurrentHashMap<>();

    PermissionService.PermissionResponse getToolDecision(String toolName) {
        Boolean allow = toolDecisionMemory.get(toolName);
        if (allow == null) {
            return null;
        }
        // Security (E): never honor a TOOL-NAME-level "always allow" for command-execution
        // tools (Bash; Codex shell commands also map to "Bash"; plus Agent launches).
        // Otherwise approving one benign command would auto-approve every future shell
        // command this session. A tool-level DENY is still honored (deny is the safe
        // direction); only the allow shortcut is suppressed, so execution falls through to
        // the command-scoped (parameter-level) memory and the approval dialog.
        if (allow && isCommandExecutionTool(toolName)) {
            return null;
        }
        return allow
                ? PermissionService.PermissionResponse.ALLOW_ALWAYS
                : PermissionService.PermissionResponse.DENY;
    }

    /**
     * Command-execution tools whose "always allow" must be scoped to the exact command
     * (parameter-level), never the tool name. See getToolDecision.
     */
    static boolean isCommandExecutionTool(String toolName) {
        return "Bash".equals(toolName) || "Agent".equals(toolName);
    }

    PermissionService.PermissionResponse getParameterDecision(String toolName, JsonObject inputs) {
        Integer remembered = parameterDecisionMemory.get(buildMemoryKey(toolName, inputs));
        if (remembered == null) {
            return null;
        }
        return PermissionService.PermissionResponse.fromValue(remembered);
    }

    String buildMemoryKey(String toolName, JsonObject inputs) {
        return toolName + ":" + (inputs != null ? inputs.toString() : "null");
    }

    void rememberToolDecision(String toolName, PermissionService.PermissionResponse decision) {
        if (toolName == null || decision == null) {
            return;
        }
        if (decision == PermissionService.PermissionResponse.ALLOW_ALWAYS) {
            toolDecisionMemory.put(toolName, true);
        } else if (decision == PermissionService.PermissionResponse.DENY) {
            toolDecisionMemory.put(toolName, false);
        }
    }

    void rememberParameterDecision(String toolName, JsonObject inputs, PermissionService.PermissionResponse decision) {
        if (toolName == null || decision == null) {
            return;
        }
        parameterDecisionMemory.put(buildMemoryKey(toolName, inputs), decision.getValue());
    }

    void clear() {
        parameterDecisionMemory.clear();
        toolDecisionMemory.clear();
    }

    int getParameterMemorySize() {
        return parameterDecisionMemory.size();
    }

    int getToolMemorySize() {
        return toolDecisionMemory.size();
    }
}
