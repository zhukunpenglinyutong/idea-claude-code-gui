/** CodeBuddy Agent SDK channel handler. */
import { sendMessage } from '../services/codebuddy/message-service.js';
import { listModels } from '../services/codebuddy/models-service.js';
import { getAuthStatus } from '../services/codebuddy/auth-service.js';

export async function handleCodeBuddyCommand(command, args, stdinData) {
  switch (command) {
    case 'send': {
      const input = stdinData && stdinData.message !== undefined
        ? stdinData
        : {
            message: args[0],
            sessionId: args[1],
            cwd: args[2],
            permissionMode: args[3],
            model: args[4],
            reasoningEffort: args[5],
            attachments: [],
          };
      await sendMessage(
        input.message || '',
        input.sessionId || '',
        input.cwd || '',
        input.permissionMode || 'default',
        input.model || '',
        input.reasoningEffort || '',
        input.attachments || [],
      );
      break;
    }
    case 'listModels':
      await listModels();
      break;
    case 'authStatus': {
      process.stdout.write(`${JSON.stringify(await getAuthStatus())}\n`);
      break;
    }
    default:
      throw new Error(`Unknown CodeBuddy command: ${command}`);
  }
}

export function getCodeBuddyCommandList() {
  return ['send', 'listModels', 'authStatus'];
}
