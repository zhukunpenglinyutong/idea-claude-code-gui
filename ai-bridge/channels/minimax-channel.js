/**
 * MiniMax Code channel command handler – keeps MiniMax-specific logic separated.
 * MiniMax Code has no Java SDK; this channel shells out to the local CLI (`minimax` / mcode).
 */
import { sendMessage as minimaxSendMessage } from '../services/minimax/message-service.js';
import { listModels as minimaxListModels } from '../services/minimax/models-service.js';

/**
 * Execute a MiniMax command.
 * @param {string} command
 * @param {string[]} args
 * @param {object|null} stdinData
 */
export async function handleMiniMaxCommand(command, args, stdinData) {
  switch (command) {
    case 'send': {
      if (stdinData && stdinData.message !== undefined) {
        const {
          message,
          sessionId,
          cwd,
          model,
          reasoningEffort,
          attachments,
          permissionMode,
        } = stdinData;
        await minimaxSendMessage(
          message,
          sessionId || '',
          cwd || '',
          model || '',
          reasoningEffort || '',
          attachments || [],
          permissionMode || ''
        );
      } else {
        await minimaxSendMessage(args[0], args[1], args[2], args[3], args[4], [], '');
      }
      break;
    }

    case 'listModels':
      minimaxListModels();
      break;

    default:
      throw new Error(`Unknown MiniMax command: ${command}`);
  }
}

export function getMiniMaxCommandList() {
  return ['send', 'listModels'];
}
