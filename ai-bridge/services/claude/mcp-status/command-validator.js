/**
 * Command validation module
 * Provides command whitelist validation to prevent arbitrary command execution
 */

import { ALLOWED_COMMANDS, VALID_EXTENSIONS } from './config.js';

/**
 * Validate whether a command is in the whitelist
 * @param {string} command - The command to validate
 * @returns {{ valid: boolean, reason?: string }} Validation result
 */
export function validateCommand(command) {
  if (!command || typeof command !== 'string') {
    return { valid: false, reason: 'Command is empty or invalid' };
  }

  // Extract the base command name (strip path prefix)
  const baseCommand = command.split('/').pop().split('\\').pop();

  // Check for an exact match in the whitelist
  if (ALLOWED_COMMANDS.has(baseCommand)) {
    return { valid: true };
  }

  // Check if it's a whitelisted command with a file extension (e.g. node.exe)
  // Extract and validate the extension
  const lastDotIndex = baseCommand.lastIndexOf('.');
  if (lastDotIndex > 0) {
    const nameWithoutExt = baseCommand.substring(0, lastDotIndex);
    const ext = baseCommand.substring(lastDotIndex).toLowerCase();

    // Verify the extension is in the allowed list
    if (!VALID_EXTENSIONS.has(ext)) {
      return {
        valid: false,
        reason: `Invalid command extension "${ext}". Allowed extensions: ${[...VALID_EXTENSIONS].filter(e => e).join(', ')}`
      };
    }

    // Verify the base command name is in the whitelist
    if (ALLOWED_COMMANDS.has(nameWithoutExt)) {
      return { valid: true };
    }
  }

  return {
    valid: false,
    reason: `Command "${baseCommand}" is not in the allowed list. Allowed: ${[...ALLOWED_COMMANDS].join(', ')}`
  };
}

// cmd.exe metacharacters that allow command chaining / redirection. When a Windows .cmd
// shim must be launched via shell:true, any arg/command containing these turns into command
// injection (e.g. args ['-y', 'pkg & calc.exe'] -> cmd.exe also runs calc.exe).
// '(' and ')' are intentionally NOT included: legitimate Windows paths such as
// "C:\\Program Files (x86)\\..." contain them.
const SHELL_METACHARACTER_REGEX = /[&|;<>\r\n`]/;

/**
 * @param {string} value - command or argument value
 * @returns {boolean} true if the value contains cmd.exe command-injection metacharacters
 */
export function hasUnsafeShellMetacharacters(value) {
  return typeof value === 'string' && SHELL_METACHARACTER_REGEX.test(value);
}
