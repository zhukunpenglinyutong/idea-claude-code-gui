/**
 * Permission Mapping Utility
 *
 * Maps unified permission concepts across different AI providers.
 * Each provider has its own permission model - this module provides
 * bidirectional translation between unified and provider-specific formats.
 *
 * Philosophy: "Simple is better than complex" - Zen of Python
 *
 * @author Inspired by Steve Jobs' pursuit of simplicity
 */

import { platform } from 'os';

/**
 * Check if running on Windows platform
 * Windows sandbox support is experimental, so we use danger-full-access mode
 * @returns {boolean}
 */
function isWindows() {
  return platform() === 'win32';
}

/**
 * Unified Permission Modes
 *
 * These are the canonical permission levels understood by the IDEA plugin.
 * All providers must map their native permissions to these modes.
 */
export const UnifiedPermissionMode = {
  /** Default: Ask user before dangerous operations */
  DEFAULT: 'default',
  /** Read-only: No file modifications or command execution */
  SANDBOX: 'sandbox',
  /** Native automatic review: provider classifier/reviewer decides approval requests */
  AUTO: 'auto',
  /** Full access: Auto-approve all operations */
  YOLO: 'yolo'
};

/**
 * Normalize arbitrary permission mode strings to our canonical identifiers.
 * Accepts values coming from the webview (e.g. `bypassPermissions`) as well as
 * internal unified constants (e.g. `yolo`). Defaults to `default`.
 *
 * @param {string|undefined|null} mode
 * @returns {{core: string, alias?: string}}
 */
function normalizeUnifiedMode(mode) {
  if (!mode) {
    return { core: UnifiedPermissionMode.DEFAULT };
  }

  const raw = mode.toString().trim();
  const normalized = raw.toLowerCase();

  if (normalized === 'auto') {
    return { core: UnifiedPermissionMode.AUTO };
  }

  if (normalized === 'bypasspermissions') {
    return { core: UnifiedPermissionMode.YOLO, alias: 'bypassPermissions' };
  }

  // acceptEdits / autoEdit (Agent Mode): auto-apply file modifications, commands still require confirmation
  if (normalized === 'acceptedits' || normalized === 'autoedit') {
    return { core: UnifiedPermissionMode.DEFAULT, alias: 'acceptEdits' };
  }

  if (normalized === 'plan' || normalized === UnifiedPermissionMode.SANDBOX) {
    return { core: UnifiedPermissionMode.SANDBOX };
  }

  if (normalized === UnifiedPermissionMode.YOLO) {
    return { core: UnifiedPermissionMode.YOLO };
  }

  return { core: UnifiedPermissionMode.DEFAULT };
}

/**
 * Claude Permission Mapping
 *
 * Claude uses simple string-based permission modes that align
 * well with our unified model.
 */
export class ClaudePermissionMapper {
  /**
   * Convert unified permission mode to Claude format
   * @param {string} unifiedMode - One of UnifiedPermissionMode values
   * @returns {string} Claude permission mode
   */
  static toProvider(unifiedMode) {
    switch (unifiedMode) {
      case UnifiedPermissionMode.DEFAULT:
        return 'default';
      case UnifiedPermissionMode.SANDBOX:
        return 'sandbox';
      case UnifiedPermissionMode.AUTO:
        return 'auto';
      case UnifiedPermissionMode.YOLO:
        return 'yolo';
      default:
        return 'default';
    }
  }

  /**
   * Convert Claude permission mode to unified format
   * @param {string} claudeMode - Claude permission mode
   * @returns {string} Unified permission mode
   */
  static fromProvider(claudeMode) {
    // Claude modes already match our unified model
    return claudeMode || UnifiedPermissionMode.DEFAULT;
  }
}

/**
 * Codex Permission Mapping
 *
 * Codex uses a different permission model based on:
 * - skipGitRepoCheck: boolean (safety check bypass)
 * - sandbox: 'read-only' | 'workspace-write' | 'danger-full-access'
 * - approvalPolicy: 'never' | 'on-request' | 'on-failure'
 * - approvalsReviewer: optional native approval reviewer
 *
 * We map these to our unified modes.
 *
 * NOTE: Windows sandbox support is experimental, so we use danger-full-access
 * mode on Windows to ensure write operations work correctly.
 */
export class CodexPermissionMapper {
  /**
   * Convert unified permission mode to Codex configuration
   * @param {string} unifiedMode - One of UnifiedPermissionMode values
   * @returns {{skipGitRepoCheck: boolean, sandbox?: string, approvalPolicy?: string, approvalsReviewer?: string}} Codex permission config
   */
  static toProvider(unifiedMode) {
    const { core, alias } = normalizeUnifiedMode(unifiedMode);

    // Check if running on Windows - sandbox is experimental on Windows
    const onWindows = isWindows();

    // Native auto review uses Codex's guarded contract: the reviewer handles approval
    // requests while workspace-write keeps execution inside the project sandbox.
    if (core === UnifiedPermissionMode.AUTO) {
      return {
        skipGitRepoCheck: true,
        sandbox: 'workspace-write',
        approvalPolicy: 'on-request',
        approvalsReviewer: 'auto_review'
      };
    }

    // Treat bypassPermissions (Full Auto / trusted) as workspace-write but completely auto-approved.
    // On Windows, use danger-full-access since sandbox is experimental
    if (alias === 'bypassPermissions') {
      return {
        skipGitRepoCheck: true,
        sandbox: onWindows ? 'danger-full-access' : 'workspace-write',
        approvalPolicy: 'never'
      };
    }

    // acceptEdits (Agent Mode): reduce approvals compared with default, while keeping safety checks
    // On Windows, use danger-full-access since sandbox is experimental
    if (alias === 'acceptEdits') {
      return {
        skipGitRepoCheck: true,
        sandbox: onWindows ? 'danger-full-access' : 'workspace-write',
        approvalPolicy: 'on-request'
      };
    }

    switch (core) {
      case UnifiedPermissionMode.SANDBOX:
        // Sandbox: Read-only mode (always prompt when attempting to write)
        // 'untrusted' was removed in Codex CLI v0.149 - its ask-before-run semantics
        // were merged into 'on-request', which older CLI versions also support (#1702).
        return {
          skipGitRepoCheck: true,
          sandbox: 'read-only',
          approvalPolicy: 'on-request'
        };

      case UnifiedPermissionMode.YOLO:
        // YOLO: Full access, no restrictions (explicit yolo selection)
        return {
          skipGitRepoCheck: true,
          sandbox: 'danger-full-access',
          approvalPolicy: 'never'
        };

      case UnifiedPermissionMode.DEFAULT:
      default:
        // Default: Allow workspace writes but still prompt before executing risky actions
        // On Windows, use danger-full-access since sandbox is experimental
        // 'untrusted' was removed in Codex CLI v0.149 - see the SANDBOX case above (#1702).
        return {
          skipGitRepoCheck: true,
          sandbox: onWindows ? 'danger-full-access' : 'workspace-write',
          approvalPolicy: 'on-request'
        };
    }
  }

  /**
   * Convert Codex configuration to unified permission mode
   * @param {{skipGitRepoCheck?: boolean, sandbox?: string, approvalsReviewer?: string, approvals_reviewer?: string}} codexConfig
   * @returns {string} Unified permission mode
   */
  static fromProvider(codexConfig) {
    const approvalsReviewer = codexConfig?.approvalsReviewer ?? codexConfig?.approvals_reviewer;
    if (approvalsReviewer === 'auto_review') {
      return UnifiedPermissionMode.AUTO;
    }
    if (!codexConfig || !codexConfig.sandbox) {
      return UnifiedPermissionMode.DEFAULT;
    }

    switch (codexConfig.sandbox) {
      case 'read-only':
        return UnifiedPermissionMode.SANDBOX;
      case 'danger-full-access':
        return UnifiedPermissionMode.YOLO;
      case 'workspace-write':
      default:
        return UnifiedPermissionMode.DEFAULT;
    }
  }
}

/**
 * Permission Mapper Factory
 *
 * Automatically selects the correct mapper based on provider type.
 * This is the main entry point for permission translation.
 *
 * Usage:
 *   const mapper = PermissionMapperFactory.getMapper('codex');
 *   const providerConfig = mapper.toProvider('yolo');
 */
export class PermissionMapperFactory {
  /**
   * Get permission mapper for a specific provider
   * @param {'claude'|'codex'|'gemini'} provider
   * @returns {ClaudePermissionMapper|CodexPermissionMapper}
   */
  static getMapper(provider) {
    switch (provider) {
      case 'claude':
        return ClaudePermissionMapper;
      case 'codex':
        return CodexPermissionMapper;
      case 'gemini':
        // TODO: Implement GeminiPermissionMapper when adding Gemini support
        throw new Error('Gemini permission mapping not yet implemented');
      default:
        throw new Error(`Unknown provider: ${provider}`);
    }
  }

  /**
   * Quick conversion: unified → provider-specific
   * @param {'claude'|'codex'|'gemini'} provider
   * @param {string} unifiedMode
   * @returns {string|object} Provider-specific permission config
   */
  static toProvider(provider, unifiedMode) {
    const mapper = this.getMapper(provider);
    return mapper.toProvider(unifiedMode);
  }

  /**
   * Quick conversion: provider-specific → unified
   * @param {'claude'|'codex'|'gemini'} provider
   * @param {string|object} providerConfig
   * @returns {string} Unified permission mode
   */
  static fromProvider(provider, providerConfig) {
    const mapper = this.getMapper(provider);
    return mapper.fromProvider(providerConfig);
  }
}
