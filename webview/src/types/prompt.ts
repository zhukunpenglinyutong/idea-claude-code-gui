import type { ConflictStrategy } from './import';

/**
 * Prompt scope type - determines where prompts are stored
 */
export type PromptScope = 'global' | 'project';
export type PromptProvider = 'claude' | 'codex';

/**
 * Prompt library configuration
 */
export interface PromptConfig {
  /** Unique identifier */
  id: string;
  /** Prompt name (max 30 characters) */
  name: string;
  /** Prompt content (max 100000 characters) */
  content: string;
  /** Creation timestamp */
  createdAt?: number;
  /** Last updated timestamp */
  updatedAt?: number;
  /** Scope of the prompt (for display purposes) */
  scope?: PromptScope;
  provider?: PromptProvider;
}

/**
 * Prompt operation result
 */
export interface PromptOperationResult {
  success: boolean;
  operation: 'add' | 'update' | 'delete';
  error?: string;
}

// ============================================================================
// Message Types for Backend Communication
// ============================================================================

/**
 * Message data for getting prompts
 */
export interface GetPromptsMessage {
  scope: PromptScope;
  provider?: PromptProvider;
}

/**
 * Message data for adding a prompt
 */
export interface AddPromptMessage {
  scope: PromptScope;
  provider?: PromptProvider;
  prompt: Omit<PromptConfig, 'scope'>;
}

/**
 * Message data for updating a prompt
 */
export interface UpdatePromptMessage {
  scope: PromptScope;
  provider?: PromptProvider;
  id: string;
  updates: Partial<Omit<PromptConfig, 'id' | 'scope'>>;
}

/**
 * Message data for deleting a prompt
 */
export interface DeletePromptMessage {
  scope: PromptScope;
  provider?: PromptProvider;
  id: string;
}

/**
 * Message data for exporting prompts
 */
export interface ExportPromptsMessage {
  scope: PromptScope;
  provider?: PromptProvider;
  promptIds: string[];
}

/**
 * Message data for importing prompts from file
 */
export interface ImportPromptsFileMessage {
  scope: PromptScope;
  provider?: PromptProvider;
}

/**
 * Message data for saving imported prompts
 */
export interface SaveImportedPromptsMessage {
  scope: PromptScope;
  provider?: PromptProvider;
  prompts: PromptConfig[];
  strategy: ConflictStrategy;
}

// ============================================================================
// Helper Types
// ============================================================================

/**
 * Generic scoped operation wrapper
 */
export interface ScopedOperation<T = void> {
  scope: PromptScope;
  data?: T;
}

/**
 * Project information
 */
export interface ProjectInfo {
  /** Project name */
  name?: string;
  /** Project path */
  path?: string;
  /** Whether project scope is available */
  available: boolean;
}
