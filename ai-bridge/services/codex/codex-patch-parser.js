/**
 * Patch text parsing for Codex apply_patch operations.
 * Extracts and parses patch content from Codex SDK response payloads.
 */

/**
 * Extracts apply_patch text from exec_command arguments.
 */
export function extractPatchFromExecCommand(cmd) {
  if (typeof cmd !== 'string' || !cmd) {
    return '';
  }
  const begin = cmd.indexOf('*** Begin Patch');
  const end = cmd.lastIndexOf('*** End Patch');
  if (begin < 0 || end < begin) {
    return '';
  }
  const patchText = cmd.slice(begin, end + '*** End Patch'.length);

  // `custom_tool_call(exec)` carries JavaScript source rather than the raw
  // apply_patch input. In that source the patch is commonly stored in a quoted
  // string, so its line breaks arrive as literal `\\n` sequences. Decode one
  // string-literal layer before handing the patch to the line-oriented parser.
  // Raw multiline patches already contain real newlines and must stay untouched.
  if (!patchText.includes('\n') && patchText.includes('\\n')) {
    try {
      return JSON.parse(`"${patchText}"`);
    } catch {
      return patchText
        .replace(/\\r\\n/g, '\n')
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\n')
        .replace(/\\t/g, '\t')
        .replace(/\\"/g, '"')
        .replace(/\\'/g, "'")
        .replace(/\\\\/g, '\\');
    }
  }

  return patchText;
}

function extractPatchFromCustomToolInput(input) {
  if (typeof input === 'string') {
    return extractPatchFromExecCommand(input);
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return '';
  }

  const candidates = [input.patch, input.input, input.code, input.command, input.cmd];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const patch = extractPatchFromExecCommand(candidate);
    if (patch) return patch;
  }
  return '';
}

/**
 * Parses hunk header line numbers from unified diff headers.
 */
function parseHunkHeader(line) {
  if (typeof line !== 'string') {
    return null;
  }

  const match = line.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/);
  if (!match) {
    return null;
  }

  return {
    oldStart: Number(match[1]),
    oldCount: match[2] ? Number(match[2]) : 1,
    newStart: Number(match[3]),
    newCount: match[4] ? Number(match[4]) : 1,
  };
}

/**
 * Extracts apply_patch text from a response_item payload.
 * Supports function_call(exec_command/apply_patch) and
 * custom_tool_call(apply_patch/exec).
 */
export function extractPatchFromResponseItemPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    return '';
  }

  const payloadType = payload.type;
  const name = typeof payload.name === 'string' ? payload.name.toLowerCase() : '';

  if (payloadType === 'custom_tool_call' && name === 'exec') {
    return extractPatchFromCustomToolInput(payload.input);
  }

  if (payloadType === 'custom_tool_call' && name === 'apply_patch') {
    if (typeof payload.input === 'string') {
      return payload.input;
    }
    if (payload.input && typeof payload.input === 'object') {
      const patch = payload.input.patch ?? payload.input.input;
      return typeof patch === 'string' ? patch : '';
    }
    return '';
  }

  if (payloadType !== 'function_call') {
    return '';
  }

  if (name === 'apply_patch') {
    if (typeof payload.arguments === 'string') {
      try {
        const args = JSON.parse(payload.arguments);
        const patch = args?.patch ?? args?.input;
        return typeof patch === 'string' ? patch : '';
      } catch {
        return '';
      }
    }
    return '';
  }

  if (name !== 'exec_command' || typeof payload.arguments !== 'string') {
    return '';
  }

  try {
    const args = JSON.parse(payload.arguments);
    return extractPatchFromExecCommand(args?.cmd);
  } catch {
    return '';
  }
}

/**
 * Parses apply_patch text into reusable edit operations.
 */
export function parseApplyPatchToOperations(patchText) {
  if (typeof patchText !== 'string' || !patchText.trim()) {
    return [];
  }

  const lines = patchText.split('\n');
  const operations = [];

  let currentPath = null;
  let currentKind = null; // add | update | delete
  let currentHunkHeader = null;
  let oldLines = [];
  let newLines = [];
  let addFileLines = [];

  const flushUpdate = () => {
    if (!currentPath || currentKind !== 'update') return;
    const oldString = oldLines.join('\n');
    const newString = newLines.join('\n');
    if (oldString === newString) return;

    let startLine;
    let endLine;
    if (currentHunkHeader) {
      const oldCount = currentHunkHeader.oldCount;
      const newCount = currentHunkHeader.newCount;
      startLine = oldCount > 0 ? currentHunkHeader.oldStart : currentHunkHeader.newStart;
      const effectiveCount = oldCount > 0 ? oldCount : newCount;
      if (effectiveCount > 1) {
        endLine = startLine + effectiveCount - 1;
      }
    }

    operations.push({
      filePath: currentPath,
      kind: currentKind,
      oldString,
      newString,
      toolName: 'edit',
      startLine,
      endLine,
    });
  };

  const flushAdd = () => {
    if (!currentPath || currentKind !== 'add') return;
    operations.push({
      filePath: currentPath,
      kind: currentKind,
      oldString: '',
      newString: addFileLines.join('\n'),
      toolName: 'write'
    });
  };

  for (const rawLine of lines) {
    const line = rawLine ?? '';

    if (line.startsWith('*** Update File: ')) {
      flushUpdate();
      flushAdd();
      currentPath = line.slice('*** Update File: '.length).trim();
      currentKind = 'update';
      currentHunkHeader = null;
      oldLines = [];
      newLines = [];
      addFileLines = [];
      continue;
    }

    if (line.startsWith('*** Add File: ')) {
      flushUpdate();
      flushAdd();
      currentPath = line.slice('*** Add File: '.length).trim();
      currentKind = 'add';
      currentHunkHeader = null;
      oldLines = [];
      newLines = [];
      addFileLines = [];
      continue;
    }

    if (line.startsWith('*** Delete File: ')) {
      flushUpdate();
      flushAdd();
      currentPath = line.slice('*** Delete File: '.length).trim();
      currentKind = 'delete';
      currentHunkHeader = null;
      oldLines = [];
      newLines = [];
      addFileLines = [];
      continue;
    }

    if (line.startsWith('*** Move to: ')) {
      const movedPath = line.slice('*** Move to: '.length).trim();
      if (movedPath) {
        currentPath = movedPath;
      }
      continue;
    }

    if (line.startsWith('*** End Patch')) {
      flushUpdate();
      flushAdd();
      currentPath = null;
      currentKind = null;
      currentHunkHeader = null;
      oldLines = [];
      newLines = [];
      addFileLines = [];
      continue;
    }

    if (!currentPath || !currentKind) {
      continue;
    }

    if (currentKind === 'delete') {
      continue;
    }

    if (currentKind === 'add') {
      if (line.startsWith('+')) {
        addFileLines.push(line.slice(1));
      }
      continue;
    }

    // update
    if (line.startsWith('@@')) {
      flushUpdate();
      currentHunkHeader = parseHunkHeader(line);
      oldLines = [];
      newLines = [];
      continue;
    }

    if (line === '\\ No newline at end of file') {
      continue;
    }

    if (line.startsWith('+')) {
      newLines.push(line.slice(1));
    } else if (line.startsWith('-')) {
      oldLines.push(line.slice(1));
    } else if (line.startsWith(' ')) {
      const content = line.slice(1);
      oldLines.push(content);
      newLines.push(content);
    }
  }

  flushUpdate();
  flushAdd();

  return operations;
}
