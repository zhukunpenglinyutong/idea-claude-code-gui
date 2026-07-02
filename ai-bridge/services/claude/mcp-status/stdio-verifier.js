/**
 * STDIO server verification module
 * Provides connection status verification for STDIO-based MCP servers
 */

import { spawn } from 'child_process';
import { MCP_STDIO_VERIFY_TIMEOUT, createSafeEnv } from './config.js';
import { log } from './logger.js';
import { validateCommand, hasUnsafeShellMetacharacters } from './command-validator.js';
import { safeKillProcess, createProcessHandlers, sendInitializeRequest } from './process-manager.js';

/**
 * Verify the connection status of an STDIO-based MCP server
 * @param {string} serverName - Server name
 * @param {Object} serverConfig - Server configuration
 * @returns {Promise<Object>} Server status info { name, status, serverInfo, error? }
 */
export async function verifyStdioServerStatus(serverName, serverConfig) {
  return new Promise((resolve) => {
    let resolved = false;
    let child = null;

    const result = {
      name: serverName,
      status: 'pending',
      serverInfo: null
    };

    const command = serverConfig.command;
    const args = serverConfig.args || [];
    const env = createSafeEnv(serverConfig.env);

    // Check if a command is specified
    if (!command) {
      result.status = 'failed';
      result.error = 'No command specified';
      resolve(result);
      return;
    }

    // Validate against command whitelist (warn only, don't block)
    const validation = validateCommand(command);
    if (!validation.valid) {
      log('warn', `[MCP Verify] Non-whitelisted command for ${serverName}: ${command} (${validation.reason})`);
      log('info', `[MCP Verify] Proceeding with verification for user-configured server: ${serverName}`);
    }

    log('info', 'Verifying STDIO server:', serverName, 'command:', command);
    log('debug', 'Full command args:', args.length, 'arguments');

    // Finalization handler
    const finalize = (status, serverInfo = null, error = null) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeoutId);
      result.status = status;
      result.serverInfo = serverInfo;
      if (error) {
        result.error = error;
      }
      safeKillProcess(child, serverName);
      resolve(result);
    };

    // Set timeout - use the STDIO-specific timeout
    const timeoutId = setTimeout(() => {
      log('debug', `Timeout for ${serverName} after ${MCP_STDIO_VERIFY_TIMEOUT}ms`);
      finalize('pending');
    }, MCP_STDIO_VERIFY_TIMEOUT);

    // Attempt to spawn the process
    try {
      // Some commands on Windows require a shell
      const useShell = process.platform === 'win32' &&
                      (command.endsWith('.cmd') || command.endsWith('.bat') ||
                       command === 'npx' || command === 'npm' ||
                       command === 'pnpm' || command === 'yarn');

      const spawnOptions = {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        // Hide the console window on Windows
        windowsHide: true
      };

      if (useShell) {
        // Security (G): with shell:true Node concatenates command+args into one string that
        // cmd.exe re-parses, so a metacharacter in any externally-sourced arg becomes command
        // injection. Refuse to launch when that risk is present instead of executing it.
        const unsafe = [command, ...args].find(hasUnsafeShellMetacharacters);
        if (unsafe) {
          log('warn', `[MCP Verify] Refusing shell launch for ${serverName}: command/args contain shell metacharacters`);
          finalize('failed', null, 'Command or args contain unsafe shell metacharacters');
          return;
        }
        spawnOptions.shell = true;
        log('debug', '[MCP Verify] Using shell for command:', command);
      }

      child = spawn(command, args, spawnOptions);
    } catch (spawnError) {
      log('debug', `Failed to spawn process for ${serverName}:`, spawnError.message);
      clearTimeout(timeoutId);
      result.status = 'failed';
      result.error = spawnError.message;
      resolve(result);
      return;
    }

    // Create event handlers
    const handlers = createProcessHandlers({
      serverName,
      child,
      finalize
    });

    // Bind event listeners
    child.stdout.on('data', handlers.stdout.onData);
    child.stderr.on('data', handlers.stderr.onData);
    child.on('error', handlers.onError);
    child.on('close', (code) => {
      if (!resolved) {
        handlers.onClose(code);
      }
    });

    // Send the initialize request
    sendInitializeRequest(child, serverName);
  });
}
