/**
 * STDIO tools retrieval module
 * Provides tool listing from STDIO-based MCP servers
 */

import { spawn } from 'child_process';
import { MCP_TOOLS_TIMEOUT, createSafeEnv, STDIO_TOOLS_MAX_LINE_LENGTH } from './config.js';
import { log } from './logger.js';
import { validateCommand, hasUnsafeShellMetacharacters } from './command-validator.js';
import { safeKillProcess } from './process-manager.js';
import { MCP_PROTOCOL_VERSION, MCP_CLIENT_INFO } from './mcp-protocol.js';

/**
 * Retrieve the tool list from an STDIO-based server
 * Follows the proper MCP STDIO handshake: initialize -> initialized -> tools/list
 * @param {string} serverName - Server name
 * @param {Object} serverConfig - Server configuration
 * @returns {Promise<Object>} Tools list response
 */
export async function getStdioServerTools(serverName, serverConfig) {
  return new Promise((resolve) => {
    let resolved = false;
    let child = null;
    let stderrBuffer = '';

    const result = {
      name: serverName,
      tools: [],
      error: null
    };

    const command = serverConfig.command;
    const args = serverConfig.args || [];
    const env = createSafeEnv(serverConfig.env);

    if (!command) {
      result.error = 'No command specified';
      resolve(result);
      return;
    }

    // Validate against command whitelist (warn only, don't block)
    const validation = validateCommand(command);
    if (!validation.valid) {
      log('warn', `[MCP Tools] Non-whitelisted command for ${serverName}: ${command} (${validation.reason})`);
      log('info', `[MCP Tools] Proceeding with tools fetch for user-configured server: ${serverName}`);
    }

    log('info', '[MCP Tools] Getting tools for STDIO server:', serverName);
    log('debug', '[MCP Tools] Command:', command, 'Args:', args.length ? args.join(' ') : '(none)');

    // State machine: 0=uninitialized, 1=awaiting initialize response, 2=initialized, 3=awaiting tools/list response
    const state = {
      step: 0,
      buffer: ''
    };

    const finalize = (tools = null, error = null) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeoutId);
      if (tools) result.tools = tools;
      result.error = error;
      if (child) {
        safeKillProcess(child, serverName);
      }
      if (error) {
        log('error', '[MCP Tools] ' + serverName + ' failed:', error);
      } else {
        log('info', '[MCP Tools] ' + serverName + ' completed:', (tools ? tools.length : 0) + ' tools');
      }
      resolve(result);
    };

    // Apply the configured timeout
    const timeoutId = setTimeout(() => {
      finalize(null, `Timeout after ${MCP_TOOLS_TIMEOUT / 1000}s`);
    }, MCP_TOOLS_TIMEOUT);

    try {
      // Some commands on Windows require a shell
      const useShell = process.platform === 'win32' &&
                      (command.endsWith('.cmd') || command.endsWith('.bat') ||
                       command === 'npx' || command === 'npm' ||
                       command === 'pnpm' || command === 'yarn');

      const spawnOptions = {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: serverConfig.cwd || undefined,
        // Hide the console window on Windows
        windowsHide: true
      };

      if (useShell) {
        // Security (G): with shell:true Node concatenates command+args into one string that
        // cmd.exe re-parses, so a metacharacter in any externally-sourced arg becomes command
        // injection. Refuse to launch when that risk is present instead of executing it.
        const unsafe = [command, ...args].find(hasUnsafeShellMetacharacters);
        if (unsafe) {
          log('warn', `[MCP Tools] Refusing shell launch for ${serverName}: command/args contain shell metacharacters`);
          finalize(null, 'Command or args contain unsafe shell metacharacters');
          return;
        }
        spawnOptions.shell = true;
        log('debug', '[MCP Tools] Using shell for command:', command);
      }

      child = spawn(command, args, spawnOptions);
      log('info', '[MCP Tools] Spawned process PID:', child.pid);
    } catch (spawnError) {
      finalize(null, 'Failed to spawn process: ' + spawnError.message);
      return;
    }

    // Handle stdout - MCP protocol messages
    child.stdout.on('data', (data) => {
      state.buffer += data.toString();

      const lines = state.buffer.split('\n');
      state.buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim() || line.length > STDIO_TOOLS_MAX_LINE_LENGTH) continue;

        log('debug', '[MCP Tools] ' + serverName + ' stdout:', line.substring(0, 100));

        try {
          const response = JSON.parse(line);

          // Phase 1: Received initialize response (id=1)
          if (state.step === 1 && response.id === 1) {
            if (response.error) {
              finalize(null, 'Initialize error: ' + (response.error.message || JSON.stringify(response.error)));
              return;
            }
            if (response.result) {
              log('info', '[MCP Tools] ' + serverName + ' received initialize response');

              // Send the initialized notification
              const initializedNotification = JSON.stringify({
                jsonrpc: '2.0',
                method: 'notifications/initialized'
              }) + '\n';
              child.stdin.write(initializedNotification);
              log('debug', '[MCP Tools] ' + serverName + ' sent initialized notification');

              state.step = 2;

              // Immediately send the tools/list request
              const toolsListRequest = JSON.stringify({
                jsonrpc: '2.0',
                id: 2,
                method: 'tools/list',
                params: {}
              }) + '\n';
              log('info', '[MCP Tools] ' + serverName + ' sending tools/list request');
              child.stdin.write(toolsListRequest);
              state.step = 3;
            }
          }
          // Phase 3: Received tools/list response (id=2)
          else if (state.step === 3 && response.id === 2) {
            if (response.error) {
              finalize(null, 'Tools/list error: ' + (response.error.message || JSON.stringify(response.error)));
              return;
            }
            if (response.result) {
              if (response.result.tools) {
                log('info', '[MCP Tools] ' + serverName + ' received ' + response.result.tools.length + ' tools');
                finalize(response.result.tools, null);
              } else {
                log('warn', '[MCP Tools] ' + serverName + ' received tools/list without tools array');
                finalize([], null);
              }
              return;
            }
          }
          // Handle other error responses
          else if (response.error) {
            finalize(null, 'Server error: ' + (response.error.message || JSON.stringify(response.error)));
            return;
          }
        } catch (parseError) {
          log('debug', '[MCP Tools] ' + serverName + ' skipped unparseable line');
        }
      }
    });

    // Handle stderr - used for debugging
    child.stderr.on('data', (data) => {
      stderrBuffer += data.toString();
      // Keep only the last 500 characters of error output
      if (stderrBuffer.length > 500) {
        stderrBuffer = stderrBuffer.substring(stderrBuffer.length - 500);
      }
    });

    child.on('error', (error) => {
      log('error', '[MCP Tools] ' + serverName + ' process error:', error.message);
      finalize(null, 'Process error: ' + error.message);
    });

    child.on('close', (code) => {
      log('debug', '[MCP Tools] ' + serverName + ' process closed with code:', code);
      if (!resolved) {
        const errorMsg = code !== 0
          ? 'Process exited with code ' + code + (stderrBuffer ? '. stderr: ' + stderrBuffer.substring(0, 200) : '')
          : 'Process closed without response';
        finalize(null, errorMsg);
      }
    });

    // Send the initialize request
    process.nextTick(() => {
      if (child && child.stdin && !child.stdin.destroyed) {
        const initRequest = JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: MCP_CLIENT_INFO
          }
        }) + '\n';
        log('info', '[MCP Tools] ' + serverName + ' sending initialize request');
        try {
          child.stdin.write(initRequest);
          state.step = 1;
        } catch (writeError) {
          finalize(null, 'Failed to write initialize request: ' + writeError.message);
        }
      } else {
        finalize(null, 'Failed to initialize stdin');
      }
    });
  });
}
