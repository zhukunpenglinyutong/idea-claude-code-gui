# Handling Permissions

Control tool usage and permissions in the Claude Agent SDK

---

# SDK Permissions

The Claude Agent SDK provides powerful permission controls that allow you to manage how Claude uses tools in your application. 

This guide covers how to implement permission systems using the `canUseTool` callback, hooks, and settings.json permission rules. For complete API documentation, see the [TypeScript SDK reference](/docs/en/agent-sdk/typescript).

## Overview

The Claude Agent SDK provides four complementary ways to control tool usage:

1. **[Permission Modes](#permission-modes)** - Global permission behavior settings that affect all tools
2. **[canUseTool callback](/docs/en/agent-sdk/typescript#canusetool)** - Runtime permission handler for cases not covered by other rules
3. **[Hooks](/docs/en/agent-sdk/hooks)** - Fine-grained control over every tool execution with custom logic
4. **[Permission rules (settings.json)](https://code.claude.com/docs/en/settings#permission-settings)** - Declarative allow/deny rules with integrated bash command parsing

Use cases for each approach:
- Permission modes - Set overall permission behavior (planning, auto-accepting edits, bypassing checks)
- `canUseTool` - Dynamic approval for uncovered cases, prompts user for permission
- Hooks - Programmatic control over all tool executions
- Permission rules - Static policies with intelligent bash command parsing

## Permission Flow Diagram

```mermaid

flowchart TD
    Start([Tool request]) --> PreHook(PreToolUse Hook)

    PreHook -->|&nbsp;&nbsp;Allow&nbsp;&nbsp;| Execute(Execute Tool)
    PreHook -->|&nbsp;&nbsp;Deny&nbsp;&nbsp;| Denied(Denied)
    PreHook -->|&nbsp;&nbsp;Ask&nbsp;&nbsp;| Callback(canUseTool Callback)
    PreHook -->|&nbsp;&nbsp;Continue&nbsp;&nbsp;| Deny(Check Deny Rules)

    Deny -->|&nbsp;&nbsp;Match&nbsp;&nbsp;| Denied
    Deny -->|&nbsp;&nbsp;No Match&nbsp;&nbsp;| Allow(Check Allow Rules)

    Allow -->|&nbsp;&nbsp;Match&nbsp;&nbsp;| Execute
    Allow -->|&nbsp;&nbsp;No Match&nbsp;&nbsp;| Ask(Check Ask Rules)

    Ask -->|&nbsp;&nbsp;Match&nbsp;&nbsp;| Callback
    Ask -->|&nbsp;&nbsp;No Match&nbsp;&nbsp;| Mode{Permission Mode?}

    Mode -->|&nbsp;&nbsp;auto&nbsp;&nbsp;| AutoReview{Native classifier}
    AutoReview -->|&nbsp;&nbsp;Approve&nbsp;&nbsp;| Execute
    AutoReview -->|&nbsp;&nbsp;Escalate&nbsp;&nbsp;| Callback
    AutoReview -->|&nbsp;&nbsp;Block&nbsp;&nbsp;| Denied
    Mode -->|&nbsp;&nbsp;bypassPermissions&nbsp;&nbsp;| Execute
    Mode -->|&nbsp;&nbsp;Other modes&nbsp;&nbsp;| Callback

    Callback -->|&nbsp;&nbsp;Allow&nbsp;&nbsp;| Execute
    Callback -->|&nbsp;&nbsp;Deny&nbsp;&nbsp;| Denied

    Denied --> DeniedResponse([Feedback to agent])

    Execute --> PostHook(PostToolUse Hook)
    PostHook --> Done([Tool Response])


```

**Processing Order:** PreToolUse Hook → Deny Rules → Allow Rules → Ask Rules → Permission Mode Check → canUseTool Callback → PostToolUse Hook

## Permission Modes

Permission modes provide global control over how Claude uses tools. You can set the permission mode when calling `query()` or change it dynamically during streaming sessions.

### Available Modes

The plugin exposes five permission modes, each with different behavior:

| Mode | Description | Tool Behavior |
| :--- | :---------- | :------------ |
| `default` | Standard permission behavior | Normal permission checks apply |
| `plan` | Planning mode - no execution | Claude can only use read-only tools and presents a plan before execution |
| `acceptEdits` | Auto-accept file edits | File edits and filesystem operations are automatically approved |
| `auto` | Provider-native automatic review | Claude's classifier approves or blocks permission requests while explicit rules still apply |
| `bypassPermissions` | Full Auto | All ordinary permission checks are bypassed (use with caution) |

### Setting Permission Mode

You can set the permission mode in two ways:

#### 1. Initial Configuration

Set the mode when creating a query:

<CodeGroup>

```typescript TypeScript
import { query } from "@anthropic-ai/claude-agent-sdk";

const result = await query({
  prompt: "Help me refactor this code",
  options: {
    permissionMode: 'default'  // Standard permission mode
  }
});
```

```python Python
from claude_agent_sdk import query

result = await query(
    prompt="Help me refactor this code",
    options={
        "permission_mode": "default"  # Standard permission mode
    }
)
```

</CodeGroup>

#### 2. Dynamic Mode Changes (Streaming Only)

Change the mode during a streaming session:

<CodeGroup>

```typescript TypeScript
import { query } from "@anthropic-ai/claude-agent-sdk";

// Create an async generator for streaming input
async function* streamInput() {
  yield { 
    type: 'user',
    message: { 
      role: 'user', 
      content: "Let's start with default permissions" 
    }
  };
  
  // Later in the conversation...
  yield {
    type: 'user',
    message: {
      role: 'user',
      content: "Now let's speed up development"
    }
  };
}

const q = query({
  prompt: streamInput(),
  options: {
    permissionMode: 'default'  // Start in default mode
  }
});

// Change mode dynamically
await q.setPermissionMode('acceptEdits');

// Process messages
for await (const message of q) {
  console.log(message);
}
```

```python Python
from claude_agent_sdk import query

async def stream_input():
    """Async generator for streaming input"""
    yield {
        "type": "user",
        "message": {
            "role": "user",
            "content": "Let's start with default permissions"
        }
    }
    
    # Later in the conversation...
    yield {
        "type": "user",
        "message": {
            "role": "user",
            "content": "Now let's speed up development"
        }
    }

q = query(
    prompt=stream_input(),
    options={
        "permission_mode": "default"  # Start in default mode
    }
)

# Change mode dynamically
await q.set_permission_mode("acceptEdits")

# Process messages
async for message in q:
    print(message)
```

</CodeGroup>

### Mode-Specific Behaviors

#### Accept Edits Mode (`acceptEdits`)

In accept edits mode:
- Eligible file edits are automatically approved
- Command execution and sub-agent launches still require explicit confirmation
- Other tools follow normal permission checks
- Speeds up development when you trust Claude's edits
- Useful for rapid prototyping and iterations

Auto-approved operations:
- File edits (Edit, Write tools) handled by the SDK's `acceptEdits` mode

Still-confirmed operations in this plugin:
- Bash commands, including filesystem commands such as `mkdir`, `touch`, `rm`, `mv`, and `cp`
- Agent/sub-agent launches

#### Native Auto Mode (`auto`)

In native auto mode:
- Claude Code sends eligible permission requests to its model classifier
- The classifier approves low-risk actions and blocks or escalates riskier actions
- Explicit `ask` and `deny` rules still apply
- The mode can be changed live with `setPermissionMode('auto')`
- Unlike Full Auto, it does not require `allowDangerouslySkipPermissions`

#### Full Auto (`bypassPermissions`)

In Full Auto:
- **ALL tool uses are automatically approved**
- No permission prompts appear
- Hooks still execute (can still block operations)
- **Use with extreme caution** - Claude has full system access
- Recommended only for controlled environments

### Mode Priority in Permission Flow

Permission modes are evaluated at a specific point in the permission flow:

1. **Hooks execute first** - Can allow, deny, ask, or continue
2. **Deny rules** are checked - Block tools regardless of mode
3. **Allow rules** are checked - Permit tools if matched
4. **Ask rules** are checked - Prompt for permission if matched
5. **Permission mode** is evaluated:
   - **`auto` mode** - Sends eligible requests to Claude's native classifier
   - **`bypassPermissions` mode** - Allows all remaining tools without ordinary prompts
   - **Other modes** - Defer to `canUseTool` callback
6. **`canUseTool` callback** - Handles remaining or escalated cases

This means:
- Hooks can always control tool use, including in Full Auto
- Explicit deny rules override all permission modes
- Ask rules are evaluated before permission modes
- Native auto review retains a provider decision boundary
- Full Auto overrides the `canUseTool` callback for unmatched tools

### Best Practices

1. **Use default mode** for controlled execution with direct user approval
2. **Use acceptEdits mode** when file edits are trusted but commands should still prompt
3. **Use native auto mode** when you want fewer prompts without removing the review boundary
4. **Avoid Full Auto** on systems with sensitive data or without external isolation
5. **Combine modes with hooks** for fine-grained control
6. **Switch modes dynamically** based on task progress and confidence

Example of mode progression:
```typescript
// Start in default mode for direct oversight
permissionMode: 'default'

// Let Claude's classifier handle eligible approval requests
await q.setPermissionMode('auto')
```

## canUseTool

The `canUseTool` callback is passed as an option when calling the `query` function. It receives the tool name and input parameters, and must return a decision- either allow or deny.

canUseTool fires whenever Claude Code would show a permission prompt to a user, e.g. hooks and permission rules do not cover it and it is not in acceptEdits mode.

Here's a complete example showing how to implement interactive tool approval:

<CodeGroup>

```typescript TypeScript
import { query } from "@anthropic-ai/claude-agent-sdk";

async function promptForToolApproval(toolName: string, input: any) {
  console.log("\n🔧 Tool Request:");
  console.log(`   Tool: ${toolName}`);
  
  // Display tool parameters
  if (input && Object.keys(input).length > 0) {
    console.log("   Parameters:");
    for (const [key, value] of Object.entries(input)) {
      let displayValue = value;
      if (typeof value === 'string' && value.length > 100) {
        displayValue = value.substring(0, 100) + "...";
      } else if (typeof value === 'object') {
        displayValue = JSON.stringify(value, null, 2);
      }
      console.log(`     ${key}: ${displayValue}`);
    }
  }
  
  // Get user approval (replace with your UI logic)
  const approved = await getUserApproval();
  
  if (approved) {
    console.log("   ✅ Approved\n");
    return {
      behavior: "allow",
      updatedInput: input
    };
  } else {
    console.log("   ❌ Denied\n");
    return {
      behavior: "deny",
      message: "User denied permission for this tool"
    };
  }
}

// Use the permission callback
const result = await query({
  prompt: "Help me analyze this codebase",
  options: {
    canUseTool: async (toolName, input) => {
      return promptForToolApproval(toolName, input);
    }
  }
});
```

```python Python
from claude_agent_sdk import query

async def prompt_for_tool_approval(tool_name: str, input_params: dict):
    print(f"\n🔧 Tool Request:")
    print(f"   Tool: {tool_name}")

    # Display parameters
    if input_params:
        print("   Parameters:")
        for key, value in input_params.items():
            display_value = value
            if isinstance(value, str) and len(value) > 100:
                display_value = value[:100] + "..."
            elif isinstance(value, (dict, list)):
                display_value = json.dumps(value, indent=2)
            print(f"     {key}: {display_value}")

    # Get user approval
    answer = input("\n   Approve this tool use? (y/n): ")

    if answer.lower() in ['y', 'yes']:
        print("   ✅ Approved\n")
        return {
            "behavior": "allow",
            "updatedInput": input_params
        }
    else:
        print("   ❌ Denied\n")
        return {
            "behavior": "deny",
            "message": "User denied permission for this tool"
        }

# Use the permission callback
result = await query(
    prompt="Help me analyze this codebase",
    options={
        "can_use_tool": prompt_for_tool_approval
    }
)
```

</CodeGroup>

## Handling the AskUserQuestion Tool

The `AskUserQuestion` tool allows Claude to ask the user clarifying questions during a conversation. When this tool is called, your `canUseTool` callback receives the questions and must return the user's answers.

### Input Structure

When `canUseTool` is called with `toolName: "AskUserQuestion"`, the input contains:

```typescript
{
  questions: [
    {
      question: "Which database should we use?",
      header: "Database",
      options: [
        { label: "PostgreSQL", description: "Relational, ACID compliant" },
        { label: "MongoDB", description: "Document-based, flexible schema" }
      ],
      multiSelect: false
    },
    {
      question: "Which features should we enable?",
      header: "Features",
      options: [
        { label: "Authentication", description: "User login and sessions" },
        { label: "Logging", description: "Request and error logging" },
        { label: "Caching", description: "Redis-based response caching" }
      ],
      multiSelect: true
    }
  ]
}
```

### Returning Answers

Return the answers in `updatedInput.answers` as a record mapping question text to the selected option label(s):

```typescript
return {
  behavior: "allow",
  updatedInput: {
    questions: input.questions,  // Pass through original questions
    answers: {
      "Which database should we use?": "PostgreSQL",
      "Which features should we enable?": "Authentication, Caching"
    }
  }
}
```

<Note>
Multi-select answers are comma-separated strings (e.g., `"Authentication, Caching"`).
</Note>

## Related Resources

- [Hooks Guide](/docs/en/agent-sdk/hooks) - Learn how to implement hooks for fine-grained control over tool execution
- [Settings: Permission Rules](https://code.claude.com/docs/en/settings#permission-settings) - Configure declarative allow/deny rules with bash command parsing