# CoDriver vnext3 notes

This increment keeps the existing plugin architecture and continues the CoDriver-only refinement pass.

## Implemented

- CoDriver-only code block cards now get a VS Code Workbench Chat-like header row with a language label and a compact copy action.
- The stock light/dark/system Markdown code block DOM is not changed; the header is only emitted when `data-theme="codriver"` is active.
- CoDriver attachment chips were compacted toward the VS Code `chat-attached-context` pattern: lower height, tighter gap, quieter borders and no persistent gradient strip.
- Completion, model, mode, provider and command popups were visually tightened toward QuickInput-style surfaces while keeping existing behaviour.
- Added `THIRD_PARTY_NOTICES.md` for the VS Code Workbench Chat UI reference.

## Still open

- Tool invocation rows need a final comparison pass against VS Code's `chatThinkingContent` and tool invocation parts.
- Thinking blocks and confirmation cards still need a more exact CoDriver pass.
- The Settings colour UI now syncs more variables, but the token layer should still be reduced to a smaller set after visual validation.
