/**
 * Extract display metadata from a Workflow (ultracode) tool input.
 *
 * A Workflow script starts with `export const meta = { name: '...',
 * description: '...' }`. The meta block is required to be a pure literal, so a
 * light regex over the script prefix is enough for display purposes — no JS
 * parsing needed.
 */
export interface WorkflowDisplayMeta {
  name?: string;
  description?: string;
}

export function extractWorkflowMeta(input: Record<string, unknown> | undefined): WorkflowDisplayMeta {
  if (!input) return {};
  const meta: WorkflowDisplayMeta = {};

  const directName = input.name;
  if (typeof directName === 'string' && directName.trim()) {
    meta.name = directName.trim();
  }

  const script = input.script;
  if (typeof script === 'string' && script) {
    const head = script.slice(0, 2_000);
    if (!meta.name) {
      const nameMatch = /\bname\s*:\s*['"`]([^'"`\n]+)['"`]/.exec(head);
      if (nameMatch) meta.name = nameMatch[1].trim();
    }
    const descMatch = /\bdescription\s*:\s*['"`]([^'"`\n]+)['"`]/.exec(head);
    if (descMatch) meta.description = descMatch[1].trim();
  }

  return meta;
}
