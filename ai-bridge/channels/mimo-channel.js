/**
 * MiMo Code channel command handler – keeps MiMo-specific logic separated.
 * MiMo Code is an OpenCode fork; uses local `mimo run --format json` (no
 * host-managed serve in MVP).
 */
import { sendMessage as mimoSendMessage } from '../services/mimo/message-service.js';
import { listModels as mimoListModels } from '../services/mimo/models-service.js';

/**
 * Execute a MiMo command.
 * @param {string} command
 * @param {string[]} args
 * @param {object|null} stdinData
 */
export async function handleMimoCommand(command, args, stdinData) {
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
        } = stdinData;
        await mimoSendMessage(
          message,
          sessionId || '',
          cwd || '',
          model || '',
          reasoningEffort || '',
          attachments || []
        );
      } else {
        await mimoSendMessage(args[0], args[1], args[2], args[3], args[4], []);
      }
      break;
    }

    case 'listModels':
      mimoListModels();
      break;

    default:
      throw new Error(`Unknown MiMo command: ${command}`);
  }
}

export function getMimoCommandList() {
  return ['send', 'listModels'];
}
