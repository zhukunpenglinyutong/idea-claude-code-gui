import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ToolInput, ToolResultBlock } from '../../types';
import { useIsToolDenied } from '../../hooks/useIsToolDenied';
import { useResolvedFileLinkTooltip } from '../../hooks/useResolvedFileLinkTooltip';
import { openFile } from '../../utils/bridge';
import { formatParamValue, truncate } from '../../utils/helpers';
import { getFileIcon, getFolderIcon } from '../../utils/fileIcons';
import { isCommandToolName, parseCommandType } from '../../utils/toolCommandPath';
import { getToolLineInfo, resolveToolTarget, summarizeToolCommand, extractPathsFromPatch } from '../../utils/toolPresentation';

const SUMMARY_FILE_STYLE: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  maxWidth: 'fit-content',
};

const FILE_ICON_STYLE: React.CSSProperties = {
  marginRight: '4px',
  display: 'flex',
  alignItems: 'center',
  width: '16px',
  height: '16px',
};

const PATCH_FILES_CONTAINER_STYLE: React.CSSProperties = {
  display: 'flex',
  gap: '8px',
  flexWrap: 'wrap',
};

const PATCH_FILE_LINK_STYLE: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
};

const LINE_INFO_STYLE: React.CSSProperties = {
  marginLeft: '8px',
  fontSize: '12px',
};

const CODICON_MAP: Record<string, string> = {
  read: 'codicon-eye',
  edit: 'codicon-edit',
  write: 'codicon-pencil',
  bash: 'codicon-terminal',
  grep: 'codicon-search',
  glob: 'codicon-folder',
  task: 'codicon-tools',
  webfetch: 'codicon-globe',
  websearch: 'codicon-search',
  delete: 'codicon-trash',
  augmentcontextengine: 'codicon-symbol-class', // Added based on Picture 2
  update_plan: 'codicon-checklist', // Update plan tool
  shell_command: 'codicon-terminal', // Shell command tool
  shell_command_read: 'codicon-eye',
  shell_command_list: 'codicon-folder',
  shell_command_search: 'codicon-search',
};

const getToolDisplayName = (t: any, name?: string, input?: ToolInput) => {
  if (!name) {
    return t('tools.toolCall');
  }

  const lowerName = name.toLowerCase();

  // Codex uses 'cmd', others use 'command'
  const commandStr = (input?.command as string | undefined) ?? (input?.cmd as string | undefined);

  // For command-executing tools, check the actual command to determine display name
  if (isCommandToolName(lowerName) && commandStr) {
    const parsed = parseCommandType(commandStr);
    switch (parsed.type) {
      case 'read':
        return t('tools.readFile');
      case 'list':
        return t('tools.listFiles');
      case 'search':
        return t('tools.search');
      default:
        return t('tools.runCommand');
    }
  }

  // Translation key mapping
  const toolKeyMap: Record<string, string> = {
    'augmentcontextengine': 'tools.contextEngine',
    'task': 'tools.task',
    'read': 'tools.readFile',
    'read_file': 'tools.readFile',
    'edit': 'tools.editFile',
    'edit_file': 'tools.editFile',
    'write': 'tools.writeFile',
    'write_to_file': 'tools.writeFile',
    'replace_string': 'tools.replaceString',
    'bash': 'tools.runCommand',
    'run_terminal_cmd': 'tools.runCommand',
    'execute_command': 'tools.executeCommand',
    'executecommand': 'tools.executeCommand',
    'shell_command': 'tools.runCommand',
    'grep': 'tools.search',
    'glob': 'tools.fileMatch',
    'webfetch': 'tools.webFetch',
    'websearch': 'tools.webSearch',
    'delete': 'tools.delete',
    'explore': 'tools.explore',
    'createdirectory': 'tools.createDirectory',
    'movefile': 'tools.moveFile',
    'copyfile': 'tools.copyFile',
    'list': 'tools.listFiles',
    'search': 'tools.search',
    'find': 'tools.findFile',
    'todowrite': 'tools.todoList',
    'update_plan': 'tools.updatePlan',
    'apply_patch': 'tools.applyPatch',
  };

  if (toolKeyMap[lowerName]) {
    return t(toolKeyMap[lowerName]);
  }

  // If it's snake_case, replace underscores with spaces and capitalize
  if (name.includes('_')) {
    return name
      .split('_')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(' ');
  }

  // If it's CamelCase (starts with uppercase), split by capital letters
  // e.g. WebSearch -> Web Search
  if (/^[A-Z]/.test(name)) {
    return name.replace(/([A-Z])/g, ' $1').trim();
  }

  return name;
};

const getToolCodicon = (name?: string, input?: ToolInput): string => {
  const lowerName = (name ?? '').toLowerCase();
  const commandStr = (input?.command as string | undefined) ?? (input?.cmd as string | undefined);

  if (isCommandToolName(lowerName) && commandStr) {
    const parsed = parseCommandType(commandStr);
    switch (parsed.type) {
      case 'read':
        return CODICON_MAP.shell_command_read ?? CODICON_MAP.shell_command;
      case 'list':
        return CODICON_MAP.shell_command_list ?? CODICON_MAP.shell_command;
      case 'search':
        return CODICON_MAP.shell_command_search ?? CODICON_MAP.shell_command;
      default:
        return CODICON_MAP.shell_command;
    }
  }

  return CODICON_MAP[lowerName] ?? 'codicon-tools';
};

const omitFields = new Set([
  'file_path',
  'path',
  'target_file',
  'notebook_path',
  'command',
  'cmd',          // Codex uses 'cmd' instead of 'command'
  'search_term',
  'description',  // Codex description field
  'workdir',      // Codex workdir field
  'yield_time_ms',
  'max_output_tokens',
]);

interface GenericToolBlockProps {
  name?: string;
  input?: ToolInput;
  result?: ToolResultBlock | null;
  /** Unique ID of the tool call, used to determine if the user denied permission */
  toolId?: string;
}

interface PatchFileLinkProps {
  path: string;
}

const PatchFileLink = ({ path }: PatchFileLinkProps) => {
  const fileName = path.split('/').pop() || path;
  const ext = fileName.includes('.') ? fileName.split('.').pop() : '';
  const tooltip = useResolvedFileLinkTooltip(path, path);

  return (
    <span
      className="clickable-file"
      onClick={(e) => {
        e.stopPropagation();
        openFile(path);
      }}
      {...tooltip}
      style={PATCH_FILE_LINK_STYLE}
    >
      <span
        style={FILE_ICON_STYLE}
        dangerouslySetInnerHTML={{ __html: getFileIcon(ext ?? '', fileName) }}
      />
      {fileName}
    </span>
  );
};

const GenericToolBlock = ({ name, input, result, toolId }: GenericToolBlockProps) => {
  const { t } = useTranslation();
  const lowerName = (name ?? '').toLowerCase();
  const [expanded, setExpanded] = useState(false);
  const isDenied = useIsToolDenied(toolId);

  // Ignore write_stdin tool - it's waiting for previous command result
  if (lowerName === 'write_stdin') {
    return null;
  }

  const target = input ? resolveToolTarget(input, name) : undefined;
  const filePath = target?.rawPath;

  // Determine tool call status based on result
  // If denied, treat as completed (show error state)
  const isCompleted = (result !== undefined && result !== null) || isDenied;
  // AskUserQuestion tool should never show as error - it's a user interaction tool
  // The is_error field may be set by SDK but it doesn't indicate a real error
  const isAskUserQuestion = lowerName === 'askuserquestion';
  // If denied, show as error state
  const isError = isDenied || (isCompleted && result?.is_error === true && !isAskUserQuestion);

  if (!input) {
    return null;
  }

  const displayName = getToolDisplayName(t, name, input);
  const codicon = getToolCodicon(name, input);

  // Codex uses 'cmd', others use 'command'
  const commandStr = (typeof input.command === 'string' ? input.command : undefined) ??
    (typeof input.cmd === 'string' ? input.cmd : undefined);

  let summary: string | null = null;
  if (target) {
    summary = target.cleanFileName || target.displayPath;
  } else if (commandStr) {
    const parsed = parseCommandType(commandStr);
    if (parsed.type === 'read' && parsed.path) {
      const pathParts = parsed.path.split('/');
      summary = pathParts[pathParts.length - 1] || parsed.path;
    } else {
      summary = summarizeToolCommand(commandStr) ?? truncate(commandStr);
    }
  } else if (typeof input.search_term === 'string') {
    summary = truncate(input.search_term);
  } else if (typeof input.pattern === 'string') {
    summary = truncate(input.pattern);
  }

  const otherParams = Object.entries(input).filter(
    ([key]) => !omitFields.has(key) && key !== 'pattern',
  );

  const hasExpandableContent = otherParams.length > 0;
  const isDirectoryPath = target?.isDirectory ?? false;
  const isFilePath = target?.isFile ?? false;
  const lineInfo = input && target ? getToolLineInfo(input, target) : {};

  // For command-executing tools with read type, treat as file if we have a path
  const isCommandRead = isCommandToolName(lowerName) && commandStr && parseCommandType(commandStr).type === 'read';
  const effectiveIsFile = isFilePath || isCommandRead;

  const handleFileClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (target) {
      openFile(target.openPath, lineInfo.start, lineInfo.end);
    }
  };

  const getFileIconSvg = () => {
    if (!target) return '';
    if (isDirectoryPath) {
      return getFolderIcon(target.cleanFileName);
    }
    const extension = target.cleanFileName.includes('.') ? target.cleanFileName.split('.').pop() : '';
    return getFileIcon(extension ?? '', target.cleanFileName);
  };

  const tooltipPath = target?.displayPath ?? filePath ?? summary ?? '';
  const fileLinkTooltip = useResolvedFileLinkTooltip(
    effectiveIsFile ? filePath : undefined,
    tooltipPath || undefined,
  );

  // Extract all file paths for apply_patch tool
  const patchContent = lowerName === 'apply_patch'
    ? ((typeof input.input === 'string' ? input.input : undefined) ??
       (typeof input.patch === 'string' ? input.patch : undefined) ??
       (typeof input.content === 'string' ? input.content : undefined))
    : undefined;
  const patchFiles = patchContent ? extractPathsFromPatch(patchContent) : [];

  const headerStyle: React.CSSProperties = {
    cursor: hasExpandableContent ? 'pointer' : 'default',
  };

  return (
    <div className="task-container">
      <div
        className="task-header"
        onClick={hasExpandableContent ? () => setExpanded((prev) => !prev) : undefined}
        style={headerStyle}
      >
        <div className="task-title-section">
          <span className={`codicon ${codicon} tool-title-icon`} />

          <span className="tool-title-text">
            {displayName}
          </span>
          {summary && patchFiles.length === 0 && (
              <span
                className={`task-summary-text tool-title-summary ${effectiveIsFile ? 'clickable-file' : ''}`}
                onClick={effectiveIsFile ? handleFileClick : undefined}
                {...(effectiveIsFile ? fileLinkTooltip : {})}
                style={(effectiveIsFile || isDirectoryPath) ? SUMMARY_FILE_STYLE : undefined}
              >
                {(effectiveIsFile || isDirectoryPath) && (
                   <span
                      style={FILE_ICON_STYLE}
                      dangerouslySetInnerHTML={{ __html: getFileIconSvg() }}
                   />
                )}
                {summary}
              </span>
            )}
          {patchFiles.length > 0 && (
            <span className="tool-title-summary" style={PATCH_FILES_CONTAINER_STYLE}>
              {patchFiles.map((path, idx) => (
                <PatchFileLink
                  key={idx}
                  path={path}
                />
              ))}
            </span>
          )}
          {lineInfo.start && (
            <span className="tool-title-summary" style={LINE_INFO_STYLE}>
              {lineInfo.end && lineInfo.end !== lineInfo.start
                ? t('tools.lineRange', { start: lineInfo.start, end: lineInfo.end })
                : t('tools.lineSingle', { line: lineInfo.start })}
            </span>
          )}
        </div>

        <div className={`tool-status-indicator ${isError ? 'error' : isCompleted ? 'completed' : 'pending'}`} />
      </div>
      {hasExpandableContent && (
        <div className={`task-details-accordion ${expanded ? 'expanded' : ''}`}>
          <div className="task-details">
            <div className="task-content-wrapper">
              {otherParams.map(([key, value]) => (
                <div key={key} className="task-field">
                  <div className="task-field-label">{key}</div>
                  <div className="task-field-content">{formatParamValue(value)}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default GenericToolBlock;
