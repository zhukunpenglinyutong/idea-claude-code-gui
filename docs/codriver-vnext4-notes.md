# CoDriver vnext4 notes

This increment keeps the existing CoDriver integration strategy: default themes keep their existing DOM and behaviour, while CoDriver receives theme-scoped presentation refinements.

## Implemented

- Added `codriver-special-content.less` and imported it from `app.less`.
- Refined CoDriver-only thinking, compact-summary, compact-notification and task-notification styling toward a quieter VS Code Workbench Chat style.
- Added CoDriver-only muted transcript attachment icons in `ContentBlockRenderer` so message-stream file chips no longer use bright per-filetype glyphs in the CoDriver theme.
- Added keyboard activation metadata to the thinking header (`role=button`, `tabIndex`, Enter/Space handling).
- Replaced CoDriver task-notification glyphs with `CoDriverIcon` status icons while keeping the old glyph path for light/dark/system.
- Added CoDriver-only styling for provider/error diagnostic cards and the permission confirmation sheet.
- Theme-gated the permission dialog timer, warning and command-collapse icons through `useIsCoDriverTheme()`.
- Polished the assistant duration/footer line to be a quiet inline status rather than a pill/card.

## Not intentionally changed

- Light, dark and system themes keep their previous component paths.
- The existing tool-block state model and permission-dialog behavior are unchanged.
- This increment does not introduce a parallel CoDriver chat implementation.
