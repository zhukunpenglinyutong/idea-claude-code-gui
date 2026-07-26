/**
 * SDK Loader - Dynamically loads optional AI SDKs
 *
 * Supports loading SDKs from the user directory ~/.codemoss/dependencies/
 * This allows users to install SDKs on demand rather than bundling them with the plugin
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { getRealHomeDir, getCodemossDir } from './path-utils.js';

// Base path for dependencies directory - uses the shared path utility
const DEPS_BASE = join(getCodemossDir(), 'dependencies');

// SDK cache
const sdkCache = new Map();
// Promise cache for in-flight loads to prevent concurrent loading of the same SDK
const loadingPromises = new Map();

// SDK definitions (kept in sync with DependencyManager.SdkDefinition)
const SDK_DEFINITIONS = {
    CLAUDE: {
        id: 'claude-sdk',
        npmPackage: '@anthropic-ai/claude-agent-sdk'
    },
    CODEX: {
        id: 'codex-sdk',
        npmPackage: '@openai/codex-sdk'
    }
};

function getSdkRootDir(sdkId) {
    return join(DEPS_BASE, sdkId);
}

function getPackageDirFromRoot(sdkRootDir, pkgName) {
    // pkgName like: "@anthropic-ai/claude-agent-sdk" or "@openai/codex-sdk"
    // Logic kept consistent with DependencyManager.getPackageDir()
    const parts = pkgName.split('/');
    return join(sdkRootDir, 'node_modules', ...parts);
}

function pickExportTarget(exportsField, condition) {
    if (!exportsField) return null;
    if (typeof exportsField === 'string') return exportsField;

    // exports: { ".": {...} } or exports: { import: "...", require: "...", default: "..." }
    const root = exportsField['.'] ?? exportsField;
    if (typeof root === 'string') return root;

    if (root && typeof root === 'object') {
        if (typeof root[condition] === 'string') return root[condition];
        if (typeof root.default === 'string') return root.default;
    }

    return null;
}

function resolveEntryFileFromPackageDir(packageDir) {
    // Node ESM does not support importing a directory path directly.
    // We must resolve to a concrete file (e.g., sdk.mjs / index.js / export target).
    const pkgJsonPath = join(packageDir, 'package.json');
    if (existsSync(pkgJsonPath)) {
        try {
            const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));

            const exportTarget =
                pickExportTarget(pkg.exports, 'import') ??
                pickExportTarget(pkg.exports, 'default');

            const candidate =
                exportTarget ??
                (typeof pkg.module === 'string' ? pkg.module : null) ??
                (typeof pkg.main === 'string' ? pkg.main : null);

            if (candidate && typeof candidate === 'string') {
                return join(packageDir, candidate);
            }
        } catch {
            // ignore and fall through to heuristic
        }
    }

    // Heuristics (covers @anthropic-ai/claude-agent-sdk which has sdk.mjs)
    const heuristicCandidates = ['sdk.mjs', 'index.mjs', 'index.js', 'dist/index.js', 'dist/index.mjs'];
    for (const file of heuristicCandidates) {
        const full = join(packageDir, file);
        if (existsSync(full)) return full;
    }

    return null;
}

function resolveExternalPackageUrl(pkgName, sdkRootDir) {
    // Resolve from package directory (works for external node_modules without touching Node's default resolver)
    const packageDir = getPackageDirFromRoot(sdkRootDir, pkgName);
    const entry = resolveEntryFileFromPackageDir(packageDir);
    if (!entry) {
        throw new Error(`Unable to resolve entry file for ${pkgName} from ${packageDir}`);
    }
    return pathToFileURL(entry).href;
}

/**
 * Check whether the Claude Code SDK is available
 * Logic kept consistent with DependencyManager.isInstalled("claude")
 */
export function isClaudeSdkAvailable() {
    const sdkId = 'claude-sdk';
    const npmPackage = '@anthropic-ai/claude-agent-sdk';
    const sdkPath = getPackageDirFromRoot(getSdkRootDir(sdkId), npmPackage);
    const exists = existsSync(sdkPath);
    console.error('[sdk-loader] isClaudeSdkAvailable:', {
        path: sdkPath,
        exists: exists,
        depsBase: DEPS_BASE
    });
    return exists;
}

/**
 * Check whether the Codex SDK is available
 * Logic kept consistent with DependencyManager.isInstalled("codex")
 */
export function isCodexSdkAvailable() {
    const sdkId = 'codex-sdk';
    const npmPackage = '@openai/codex-sdk';
    const sdkPath = getPackageDirFromRoot(getSdkRootDir(sdkId), npmPackage);
    const exists = existsSync(sdkPath);
    console.error('[sdk-loader] isCodexSdkAvailable:', {
        path: sdkPath,
        exists: exists
    });
    return exists;
}

/**
 * Dynamically load the Claude SDK
 * @returns {Promise<{query: Function, ...}>}
 * @throws {Error} If the SDK is not installed
 */
export async function loadClaudeSdk() {
    console.error('[DIAG-SDK] loadClaudeSdk() called');

    // Return the cached SDK if available
    if (sdkCache.has('claude')) {
        console.error('[DIAG-SDK] Returning cached SDK');
        return sdkCache.get('claude');
    }

    // If a load is already in progress, return the same promise to prevent duplicate loading
    if (loadingPromises.has('claude')) {
        console.error('[DIAG-SDK] SDK loading in progress, returning existing promise');
        return loadingPromises.get('claude');
    }

    const sdkRootDir = getSdkRootDir('claude-sdk');
    const sdkPath = getPackageDirFromRoot(sdkRootDir, '@anthropic-ai/claude-agent-sdk');
    console.error('[DIAG-SDK] SDK path:', sdkPath);
    console.error('[DIAG-SDK] SDK path exists:', existsSync(sdkPath));

    if (!existsSync(sdkPath)) {
        console.error('[DIAG-SDK] SDK not installed at path');
        throw new Error('SDK_NOT_INSTALLED:claude');
    }

    // Create and cache the loading promise
    const loadPromise = (async () => {
        try {
            console.error('[DIAG-SDK] SDK root dir:', sdkRootDir);

            // Node ESM does not support import(directory); must resolve to a concrete file (e.g. sdk.mjs)
            const resolvedUrl = resolveExternalPackageUrl('@anthropic-ai/claude-agent-sdk', sdkRootDir);
            console.error('[DIAG-SDK] Resolved URL:', resolvedUrl);

            console.error('[DIAG-SDK] Starting dynamic import...');
            const sdk = await import(resolvedUrl);
            console.error('[DIAG-SDK] SDK imported successfully, exports:', Object.keys(sdk));

            sdkCache.set('claude', sdk);
            return sdk;
        } catch (error) {
            console.error('[DIAG-SDK] SDK import failed:', error.message);
            const pkgDir = getPackageDirFromRoot(sdkRootDir, '@anthropic-ai/claude-agent-sdk');
            const hintFile = join(pkgDir, 'sdk.mjs');
            const hint = existsSync(hintFile) ? ` Did you mean to import ${hintFile}?` : '';
            throw new Error(`Failed to load Claude SDK: ${error.message}${hint}`);
        } finally {
            // Clear the promise cache once loading is complete
            loadingPromises.delete('claude');
        }
    })();

    loadingPromises.set('claude', loadPromise);
    return loadPromise;
}

/**
 * Dynamically load the Codex SDK
 * @returns {Promise<{Codex: Class, ...}>}
 * @throws {Error} If the SDK is not installed
 */
export async function loadCodexSdk() {
    // Return the cached SDK if available
    if (sdkCache.has('codex')) {
        return sdkCache.get('codex');
    }

    // If a load is already in progress, return the same promise to prevent duplicate loading
    if (loadingPromises.has('codex')) {
        return loadingPromises.get('codex');
    }

    const sdkRootDir = getSdkRootDir('codex-sdk');
    const sdkPath = getPackageDirFromRoot(sdkRootDir, '@openai/codex-sdk');

    if (!existsSync(sdkPath)) {
        throw new Error('SDK_NOT_INSTALLED:codex');
    }

    // Create and cache the loading promise
    const loadPromise = (async () => {
        try {
            const resolvedUrl = resolveExternalPackageUrl('@openai/codex-sdk', sdkRootDir);
            const sdk = await import(resolvedUrl);

            sdkCache.set('codex', sdk);
            return sdk;
        } catch (error) {
            throw new Error(`Failed to load Codex SDK: ${error.message}`);
        } finally {
            loadingPromises.delete('codex');
        }
    })();

    loadingPromises.set('codex', loadPromise);
    return loadPromise;
}

/**
 * Load the base Anthropic SDK (used as an API fallback)
 * @returns {Promise<{Anthropic: Class}>}
 */
export async function loadAnthropicSdk() {
    // Return the cached SDK if available
    if (sdkCache.has('anthropic')) {
        return sdkCache.get('anthropic');
    }

    // If a load is already in progress, return the same promise to prevent duplicate loading
    if (loadingPromises.has('anthropic')) {
        return loadingPromises.get('anthropic');
    }

    const sdkRootDir = getSdkRootDir('claude-sdk');
    const sdkPath = join(sdkRootDir, 'node_modules', '@anthropic-ai', 'sdk');

    if (!existsSync(sdkPath)) {
        throw new Error('SDK_NOT_INSTALLED:anthropic');
    }

    // Create and cache the loading promise
    const loadPromise = (async () => {
        try {
            const resolvedUrl = resolveExternalPackageUrl('@anthropic-ai/sdk', sdkRootDir);
            const sdk = await import(resolvedUrl);

            sdkCache.set('anthropic', sdk);
            return sdk;
        } catch (error) {
            throw new Error(`Failed to load Anthropic SDK: ${error.message}`);
        } finally {
            loadingPromises.delete('anthropic');
        }
    })();

    loadingPromises.set('anthropic', loadPromise);
    return loadPromise;
}

/**
 * Load the Bedrock SDK
 * @returns {Promise<{AnthropicBedrock: Class}>}
 */
export async function loadBedrockSdk() {
    // Return the cached SDK if available
    if (sdkCache.has('bedrock')) {
        return sdkCache.get('bedrock');
    }

    // If a load is already in progress, return the same promise to prevent duplicate loading
    if (loadingPromises.has('bedrock')) {
        return loadingPromises.get('bedrock');
    }

    const sdkRootDir = getSdkRootDir('claude-sdk');
    const sdkPath = join(sdkRootDir, 'node_modules', '@anthropic-ai', 'bedrock-sdk');

    if (!existsSync(sdkPath)) {
        throw new Error('SDK_NOT_INSTALLED:bedrock');
    }

    // Create and cache the loading promise
    const loadPromise = (async () => {
        try {
            const resolvedUrl = resolveExternalPackageUrl('@anthropic-ai/bedrock-sdk', sdkRootDir);
            const sdk = await import(resolvedUrl);

            sdkCache.set('bedrock', sdk);
            return sdk;
        } catch (error) {
            throw new Error(`Failed to load Bedrock SDK: ${error.message}`);
        } finally {
            loadingPromises.delete('bedrock');
        }
    })();

    loadingPromises.set('bedrock', loadPromise);
    return loadPromise;
}

/**
 * Get the installation status of all SDKs
 */
export function getSdkStatus() {
    // Uses the same path resolution logic as DependencyManager
    const claudeInstalled = isClaudeSdkAvailable();
    const codexInstalled = isCodexSdkAvailable();

    return {
        claude: {
            installed: claudeInstalled,
            path: getPackageDirFromRoot(getSdkRootDir('claude-sdk'), '@anthropic-ai/claude-agent-sdk')
        },
        codex: {
            installed: codexInstalled,
            path: getPackageDirFromRoot(getSdkRootDir('codex-sdk'), '@openai/codex-sdk')
        }
    };
}

/**
 * Clear the SDK cache
 * Should be called after an SDK is reinstalled
 */
export function clearSdkCache() {
    sdkCache.clear();
}

/**
 * Verify that the SDK is installed, throwing a user-friendly error if not
 * @param {string} provider - 'claude' or 'codex'
 * @throws {Error} If the SDK is not installed
 */
export function requireSdk(provider) {
    if (provider === 'claude' && !isClaudeSdkAvailable()) {
        const error = new Error('Claude Code SDK not installed. Please install via Settings > Dependencies.');
        error.code = 'SDK_NOT_INSTALLED';
        error.provider = 'claude';
        throw error;
    }

    if (provider === 'codex' && !isCodexSdkAvailable()) {
        const error = new Error('Codex SDK not installed. Please install via Settings > Dependencies.');
        error.code = 'SDK_NOT_INSTALLED';
        error.provider = 'codex';
        throw error;
    }
}
