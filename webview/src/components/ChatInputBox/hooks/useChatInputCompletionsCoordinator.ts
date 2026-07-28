import { useCallback, useEffect, useRef, type MutableRefObject, type RefObject } from 'react';
import type { CommandItem, FileItem, TriggerQuery } from '../types.js';
import { useCompletionDropdown } from './useCompletionDropdown.js';
import { useCompletionTriggerDetection } from './useCompletionTriggerDetection.js';
import { useInlineHistoryCompletion } from './useInlineHistoryCompletion.js';
import {
  agentProvider,
  agentToDropdownItem,
  commandToDropdownItem,
  dollarCommandProvider,
  dollarCommandToDropdownItem,
  fileReferenceProvider,
  fileToDropdownItem,
  promptProvider,
  promptToDropdownItem,
  slashCommandProvider,
  type AgentItem,
  type PromptItem,
} from '../providers/index.js';
import { setCursorOffset } from '../utils/selectionUtils.js';

interface UseChatInputCompletionsCoordinatorOptions {
  editableRef: RefObject<HTMLDivElement | null>;
  sharedComposingRef: RefObject<boolean>;
  justRenderedTagRef: RefObject<boolean>;
  getTextContent: () => string;
  pathMappingRef: MutableRefObject<Map<string, string>>;
  setCursorAfterPath: (path: string | null) => void;
  closeAllCompletionsRef: MutableRefObject<() => void>;
  handleInputRef: MutableRefObject<() => void>;
  currentProvider: string;
  onAgentSelect?: (agent: { id: string; name: string; prompt?: string } | null) => void;
  onOpenAgentSettings?: () => void;
  onOpenPromptSettings?: () => void;
}

function replaceTextAndSync(
  editableRef: RefObject<HTMLDivElement | null>,
  text: string,
  replacement: string,
  query: TriggerQuery,
  replaceText: (input: string, replacementText: string, currentQuery: TriggerQuery) => string,
  handleInput: () => void
) {
  if (!editableRef.current) return;
  const newText = replaceText(text, replacement, query);
  editableRef.current.innerText = newText;
  const cursorPos = query.start + replacement.length;
  setCursorOffset(editableRef.current, cursorPos);
  handleInput();
}

export function useChatInputCompletionsCoordinator({
  editableRef,
  sharedComposingRef,
  justRenderedTagRef,
  getTextContent,
  pathMappingRef,
  setCursorAfterPath,
  closeAllCompletionsRef,
  handleInputRef,
  currentProvider,
  onAgentSelect,
  onOpenAgentSettings,
  onOpenPromptSettings,
}: UseChatInputCompletionsCoordinatorOptions) {
  const renderFileTagsRef = useRef<() => void>(() => {});

  const fileCompletion = useCompletionDropdown<FileItem>({
    trigger: '@',
    provider: fileReferenceProvider,
    toDropdownItem: fileToDropdownItem,
    onSelect: (file, query) => {
      if (!editableRef.current || !query) return;

      const text = getTextContent();
      const path = file.absolutePath || file.path;
      const replacement = file.type === 'directory' ? `@${path}` : `@${path} `;
      const newText = fileCompletion.replaceText(text, replacement, query);

      if (file.absolutePath) {
        pathMappingRef.current.set(file.name, file.absolutePath);
        pathMappingRef.current.set(file.path, file.absolutePath);
        pathMappingRef.current.set(file.absolutePath, file.absolutePath);
      }

      editableRef.current.innerText = newText;
      const cursorPos = query.start + replacement.length;
      setCursorOffset(editableRef.current, cursorPos);
      handleInputRef.current();
      setCursorAfterPath(path);

      setTimeout(() => {
        renderFileTagsRef.current();
      }, 0);
    },
  });

  const commandCompletion = useCompletionDropdown<CommandItem>({
    trigger: '/',
    provider: slashCommandProvider,
    toDropdownItem: commandToDropdownItem,
    onSelect: (command, query) => {
      if (!editableRef.current || !query) return;
      replaceTextAndSync(
        editableRef,
        getTextContent(),
        `${command.label} `,
        query,
        commandCompletion.replaceText,
        () => handleInputRef.current()
      );
    },
  });

  const agentCompletion = useCompletionDropdown<AgentItem>({
    trigger: '#',
    provider: agentProvider,
    toDropdownItem: agentToDropdownItem,
    onSelect: (agent, query) => {
      if (
        agent.id === '__loading__' ||
        agent.id === '__empty__' ||
        agent.id === '__empty_state__'
      ) {
        return;
      }

      if (agent.id === '__create_new__') {
        onOpenAgentSettings?.();
      } else {
        onAgentSelect?.({ id: agent.id, name: agent.name, prompt: agent.prompt });
      }

      if (!editableRef.current || !query) return;
      const newText = agentCompletion.replaceText(getTextContent(), '', query);
      editableRef.current.innerText = newText;
      setCursorOffset(editableRef.current, query.start);
      handleInputRef.current();
    },
  });

  const promptDataProvider = useCallback(
    (query: string, signal: AbortSignal) => promptProvider(query, signal, currentProvider),
    [currentProvider],
  );

  const promptCompletion = useCompletionDropdown<PromptItem>({
    trigger: '!',
    provider: promptDataProvider,
    toDropdownItem: promptToDropdownItem,
    onSelect: (prompt, query) => {
      if (
        prompt.id === '__loading__' ||
        prompt.id === '__empty__' ||
        prompt.id === '__empty_state__'
      ) {
        return;
      }

      if (prompt.id === '__create_new__') {
        onOpenPromptSettings?.();
        if (!editableRef.current || !query) return;
        const newText = promptCompletion.replaceText(getTextContent(), '', query);
        editableRef.current.innerText = newText;
        setCursorOffset(editableRef.current, query.start);
        handleInputRef.current();
        return;
      }

      if (!editableRef.current || !query) return;
      replaceTextAndSync(
        editableRef,
        getTextContent(),
        prompt.content,
        query,
        promptCompletion.replaceText,
        () => handleInputRef.current()
      );
    },
  });

  const dollarCommandCompletion = useCompletionDropdown<CommandItem>({
    trigger: '$',
    provider: dollarCommandProvider,
    toDropdownItem: dollarCommandToDropdownItem,
    onSelect: (skill, query) => {
      if (!editableRef.current || !query) return;
      replaceTextAndSync(
        editableRef,
        getTextContent(),
        `${skill.label} `,
        query,
        dollarCommandCompletion.replaceText,
        () => handleInputRef.current()
      );
    },
  });

  const closeAllCompletions = useCallback(() => {
    fileCompletion.close();
    commandCompletion.close();
    agentCompletion.close();
    promptCompletion.close();
    dollarCommandCompletion.close();
  }, [fileCompletion, commandCompletion, agentCompletion, promptCompletion, dollarCommandCompletion]);

  useEffect(() => {
    closeAllCompletionsRef.current = closeAllCompletions;
  }, [closeAllCompletions, closeAllCompletionsRef]);

  const inlineCompletion = useInlineHistoryCompletion({
    debounceMs: 100,
    minQueryLength: 2,
  });

  const { debouncedDetectCompletion } = useCompletionTriggerDetection({
    editableRef,
    sharedComposingRef,
    justRenderedTagRef,
    getTextContent,
    fileCompletion,
    commandCompletion,
    agentCompletion,
    promptCompletion,
    dollarCommandCompletion,
    isDollarTriggerEnabled: currentProvider === 'codex',
  });

  // Note: completion objects from useCompletionDropdown are stable references.
  // We access .isOpen at call time, so we don't need .isOpen in deps.
  const syncInlineCompletion = useCallback((text: string) => {
    const isOtherCompletionOpen =
      fileCompletion.isOpen ||
      commandCompletion.isOpen ||
      agentCompletion.isOpen ||
      promptCompletion.isOpen ||
      dollarCommandCompletion.isOpen;

    if (!isOtherCompletionOpen) {
      inlineCompletion.updateQuery(text);
    } else {
      inlineCompletion.clear();
    }
  }, [
    fileCompletion,
    commandCompletion,
    agentCompletion,
    promptCompletion,
    dollarCommandCompletion,
    inlineCompletion,
  ]);

  const setRenderFileTags = useCallback((renderFileTags: () => void) => {
    renderFileTagsRef.current = renderFileTags;
  }, []);

  return {
    fileCompletion,
    commandCompletion,
    agentCompletion,
    promptCompletion,
    dollarCommandCompletion,
    inlineCompletion,
    closeAllCompletions,
    debouncedDetectCompletion,
    syncInlineCompletion,
    setRenderFileTags,
  };
}
