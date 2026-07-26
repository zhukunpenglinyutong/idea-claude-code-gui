#!/usr/bin/env node

/**
 * AI Bridge Channel Manager
 * Unified bridge entry point for Claude and Codex SDKs
 *
 * Command format:
 *   node channel-manager.js <provider> <command> [args...]
 *
 * Provider:
 *   claude - Claude Agent SDK (@anthropic-ai/claude-agent-sdk)
 *   codex  - Codex SDK (@openai/codex-sdk)
 *
 * Commands:
 *   send                - Send a message (parameters passed via stdin as JSON)
 *   sendWithAttachments - Send a message with attachments (claude only)
 *   getSession          - Retrieve session message history (claude only)
 *
 * Design notes:
 * - Single entry point that dispatches to different services based on the provider parameter
 * - sessionId/threadId is managed by the caller (Java side)
 * - Messages and other parameters are passed via stdin in JSON format
 */

// Shared utilities
import { readStdinData } from './utils/stdin-utils.js';
import { handleClaudeCommand } from './channels/claude-channel.js';
import { handleCodexCommand } from './channels/codex-channel.js';
import { getSdkStatus, isClaudeSdkAvailable, isCodexSdkAvailable } from './utils/sdk-loader.js';
import { injectStartupEnvVars, configureCliIdentity } from './config/api-config.js';

// Sync proxy/TLS settings and AWS credentials from ~/.claude/settings.json
// BEFORE any network activity, but only for explicitly authorized Local
// settings.json / CLI Login modes. Without this, users behind corporate
// SSL-inspection proxies in those modes will get certificate verification
// errors, and Bedrock auth fails for desktop-launched IDEs.
injectStartupEnvVars();

// Configure CLI client identity before any SDK loading
configureCliIdentity();

// Diagnostic logging: startup info
console.error('[DIAG-ENTRY] ========== CHANNEL-MANAGER STARTUP ==========');
console.error('[DIAG-ENTRY] Node.js version:', process.version);
console.error('[DIAG-ENTRY] Platform:', process.platform);
console.error('[DIAG-ENTRY] CWD:', process.cwd());
console.error('[DIAG-ENTRY] argv:', process.argv);

// Parse command-line arguments
const provider = process.argv[2];
const command = process.argv[3];
const args = process.argv.slice(4);

// Diagnostic logging: argument info
console.error('[DIAG-ENTRY] Provider:', provider);
console.error('[DIAG-ENTRY] Command:', command);
console.error('[DIAG-ENTRY] Args:', args);

// Error handling
process.on('uncaughtException', (error) => {
  console.error('[UNCAUGHT_ERROR]', error.message);
  console.log(JSON.stringify({
    success: false,
    error: error.message
  }));
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED_REJECTION]', reason);
  console.log(JSON.stringify({
    success: false,
    error: String(reason)
  }));
  process.exit(1);
});

/**
 * Handle system-level commands (e.g., SDK status checks)
 */
async function handleSystemCommand(command, args, stdinData) {
  switch (command) {
    case 'getSdkStatus':
      // Return the installation status of all SDKs
      const status = getSdkStatus();
      console.log(JSON.stringify({
        success: true,
        data: status
      }));
      break;

    case 'checkClaudeSdk':
      // Check if Claude SDK is available
      console.log(JSON.stringify({
        success: true,
        available: isClaudeSdkAvailable()
      }));
      break;

    case 'checkCodexSdk':
      // Check if Codex SDK is available
      console.log(JSON.stringify({
        success: true,
        available: isCodexSdkAvailable()
      }));
      break;

    default:
      console.log(JSON.stringify({
        success: false,
        error: 'Unknown system command: ' + command
      }));
      process.exit(1);
  }
}

const providerHandlers = {
  claude: handleClaudeCommand,
  codex: handleCodexCommand,
  system: handleSystemCommand
};

// Execute command
(async () => {
  console.error('[DIAG-EXEC] ========== STARTING EXECUTION ==========');
  try {
    // Validate provider
    console.error('[DIAG-EXEC] Validating provider...');
    if (!provider || !providerHandlers[provider]) {
      console.error('Invalid provider. Use "claude", "codex", or "system"');
      console.log(JSON.stringify({
        success: false,
        error: 'Invalid provider: ' + provider
      }));
      process.exit(1);
    }

    // Validate command
    if (!command) {
      console.error('No command specified');
      console.log(JSON.stringify({
        success: false,
        error: 'No command specified'
      }));
      process.exit(1);
    }

    // Read stdin data
    console.error('[DIAG-EXEC] Reading stdin data...');
    const stdinData = await readStdinData(provider);
    console.error('[DIAG-EXEC] Stdin data received, keys:', stdinData ? Object.keys(stdinData) : 'null');

    // Dispatch to the appropriate provider handler
    console.error('[DIAG-EXEC] Dispatching to handler:', provider);
    const handler = providerHandlers[provider];
    await handler(command, args, stdinData);
    console.error('[DIAG-EXEC] Handler completed successfully');

    // IMPORTANT: Do not use process.exit(0) here -- it terminates the process
    // before the stdout buffer is fully flushed, which can truncate large JSON
    // output (e.g., the history returned by getSession).
    // Instead, set process.exitCode and let the process exit naturally so all I/O completes.
    process.exitCode = 0;

    // For the rewindFiles command we need to force-exit, because it restores
    // an SDK session whose MCP connections may stay open and prevent the
    // process from exiting naturally. Its output is small, so truncation is not a concern.
    if (command === 'rewindFiles') {
      // Allow a short delay for the stdout buffer to flush
      setTimeout(() => process.exit(0), 100);
    }

  } catch (error) {
    console.error('[COMMAND_ERROR]', error.message);
    console.log(JSON.stringify({
      success: false,
      error: error.message
    }));
    process.exit(1);
  }
})();
