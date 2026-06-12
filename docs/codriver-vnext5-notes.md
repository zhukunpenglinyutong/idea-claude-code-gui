# CoDriver vnext5 notes

This pass finishes the first visual correction cycle before manual IDE testing.

## What changed

- Added `codriver-final-pass.less` and import it after the shared component styles, so CoDriver overrides win without touching light/dark/system.
- Neutralized remaining inline SVG file icons in CoDriver-only contexts:
  - inline composer file tags (`.file-tag`)
  - file reference dropdown rows (`.dropdown-item-icon`)
  - context/file/tool icons that still receive inline SVG markup
- Added stable kind classes for generated composer file tags (`file-tag-code`, `file-tag-folder`, `file-tag-terminal`, `file-tag-service`).
- Added `data-type` to dropdown rows so CoDriver can style file/directory/command rows without changing default theme behaviour.
- Tightened the final CoDriver transcript spacing, tool invocation rows, composer surface and picker/dropdown surface.
- Kept all visual changes under `html[data-theme="codriver"]`.

## Manual test focus

1. Inline `@Main.java`/file tags inside the composer should no longer show bright Java cup colors in CoDriver.
2. File suggestions in the dropdown should no longer show saturated IDE/file-type SVG colors in CoDriver.
3. Tool invocation rows should stay quiet and left-status oriented.
4. Light/dark/system must keep their existing file icons and attachment markup.
