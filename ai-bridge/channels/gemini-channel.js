/**
 * Gemini / Antigravity CLI channel command handler.
 * Provider id in the plugin UI: "gemini"
 * Transport: agy headless stream-json (not ACP, not Claude SDK).
 */

import { sendMessage as geminiSendMessage } from '../services/gemini/message-service.js';
import {
  isAgyAvailable,
  buildAgyModelsCatalog,
  buildGeminiContextUsagePayload,
  resolveAgyBinary,
} from '../services/gemini/agy-utils.js';

export async function handleGeminiCommand(command, args, stdinData) {
  switch (command) {
    case 'send': {
      if (stdinData && (stdinData.message !== undefined || stdinData.prompt !== undefined)) {
        const options = {
          message: stdinData.message ?? stdinData.prompt ?? '',
          sessionId: stdinData.sessionId || '',
          cwd: stdinData.cwd || '',
          permissionMode: stdinData.permissionMode || '',
          model: stdinData.model || '',
          attachments: stdinData.attachments || [],
          openedFiles: stdinData.openedFiles ?? null,
          agentPrompt: stdinData.agentPrompt || '',
          streaming: stdinData.streaming !== undefined ? stdinData.streaming : true,
          reasoningEffort: stdinData.reasoningEffort || '',
          agent: stdinData.agent || '',
          printTimeout: stdinData.printTimeout || '',
        };
        await geminiSendMessage(options);
      } else {
        await geminiSendMessage(args[0], args[1], args[2], args[3], args[4]);
      }
      break;
    }

    case 'getContextUsage': {
      const payload = buildGeminiContextUsagePayload({
        usedTokens: stdinData?.usedTokens ?? 0,
        maxTokens: stdinData?.maxTokens ?? 200_000,
        model: stdinData?.model || '',
      });
      console.log(JSON.stringify(payload));
      break;
    }

    case 'getUsage': {
      console.log(JSON.stringify({
        success: true,
        data: {
          unavailable: true,
          message:
            'Antigravity CLI billing/quota is available via `agy` TUI (/usage, /credits). '
            + 'Per-turn token usage is streamed on [USAGE] during chat.',
          source: 'channel-fallback',
        },
      }));
      break;
    }

    case 'listModels': {
      const catalog = await buildAgyModelsCatalog();
      console.log(JSON.stringify({
        success: true,
        models: catalog.models,
        families: catalog.families,
        binary: catalog.binary || resolveAgyBinary() || '',
      }));
      break;
    }

    case 'checkCli': {
      console.log(JSON.stringify({
        success: true,
        available: isAgyAvailable(),
        binary: resolveAgyBinary() || '',
      }));
      break;
    }

    default:
      throw new Error(`Unknown Gemini/agy command: ${command}`);
  }
}

export function getGeminiCommandList() {
  return ['send', 'getContextUsage', 'getUsage', 'listModels', 'checkCli'];
}
