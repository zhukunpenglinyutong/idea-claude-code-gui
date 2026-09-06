/**
 * Anthropic SDK direct message sender.
 * Fallback for third-party API proxies that don't support the Claude Agent SDK.
 */

import { randomUUID } from 'crypto';
import { loadClaudeSettings, getCliUserAgent } from '../../config/api-config.js';
import { selectWorkingDirectory } from '../../utils/path-utils.js';
import { resolveModelFromSettings } from '../../utils/model-utils.js';
import { loadSessionHistory, persistJsonlMessage } from './session-service.js';
import { ensureAnthropicSdk, ensureBedrockSdk, truncateErrorContent } from './message-utils.js';
import { buildContentBlocks } from './attachment-service.js';

export async function sendMessageWithAnthropicSDK(message, resumeSessionId, cwd, permissionMode, model, apiKey, baseUrl, authType, attachments = []) {
  try {
    // Dynamically load Anthropic SDK
    const anthropicModule = await ensureAnthropicSdk();
    const Anthropic = anthropicModule.default || anthropicModule.Anthropic || anthropicModule;

    const workingDirectory = selectWorkingDirectory(cwd);
    try {
      process.chdir(workingDirectory);
    } catch {
    }

    const sessionId = (resumeSessionId && resumeSessionId !== '') ? resumeSessionId : randomUUID();
    const rawModelId = model || 'claude-sonnet-4-5';

    // FIX: Resolve the actual model name from settings.json model mapping.
    // When using third-party API proxies, the internal model ID (e.g. 'claude-sonnet-4-6')
    // may not be recognized. Use the user's configured model mapping if available.
    const sdkSettings = loadClaudeSettings();
    const modelId = resolveModelFromSettings(rawModelId, sdkSettings?.env);
    console.log('[DEBUG] (AnthropicSDK) Model resolved for API:', rawModelId, '->', modelId);

    // Build CLI-style headers for API identification
    const cliHeaders = {
      'x-app': 'cli',
      'User-Agent': getCliUserAgent()
    };

    // Use the correct SDK parameters based on auth type
    // authType = 'auth_token': use authToken parameter (Bearer authentication)
    // authType = 'api_key': use apiKey parameter (x-api-key authentication)
    let client;
    if (authType === 'auth_token') {
      console.log('[DEBUG] Using Bearer authentication (ANTHROPIC_AUTH_TOKEN)');
      // Use authToken parameter (Bearer authentication) and clear apiKey
      client = new Anthropic({
        authToken: apiKey,
        apiKey: null,  // Explicitly set to null to avoid sending the x-api-key header
        baseURL: baseUrl || undefined,
        defaultHeaders: cliHeaders
      });
      // Prefer Bearer (ANTHROPIC_AUTH_TOKEN) and prevent sending x-api-key
      delete process.env.ANTHROPIC_API_KEY;
      process.env.ANTHROPIC_AUTH_TOKEN = apiKey;
    } else if (authType === 'aws_bedrock') {
      console.log('[DEBUG] Using AWS_BEDROCK authentication (AWS_BEDROCK)');
      // Dynamically load Bedrock SDK
      const bedrockModule = await ensureBedrockSdk();
      const AnthropicBedrock = bedrockModule.AnthropicBedrock || bedrockModule.default || bedrockModule;
      client = new AnthropicBedrock({
        defaultHeaders: cliHeaders
      });
    } else {
      console.log('[DEBUG] Using API Key authentication (ANTHROPIC_API_KEY)');
      // Use apiKey parameter (x-api-key authentication)
      client = new Anthropic({
        apiKey,
        baseURL: baseUrl || undefined,
        defaultHeaders: cliHeaders
      });
    }

    console.log('[MESSAGE_START]');
    console.log('[SESSION_ID]', sessionId);
    console.log('[DEBUG] Using Anthropic SDK fallback for custom Base URL (non-streaming)');
    console.log('[DEBUG] Model:', modelId);
    console.log('[DEBUG] Base URL:', baseUrl);
    console.log('[DEBUG] Auth type:', authType || 'api_key (default)');

    const userContent = (Array.isArray(attachments) && attachments.length > 0)
      ? await buildContentBlocks(attachments, message)
      : [{ type: 'text', text: message }];

    persistJsonlMessage(sessionId, cwd, {
      type: 'user',
      message: { content: userContent }
    });

    let messagesForApi = [{ role: 'user', content: userContent }];
    if (resumeSessionId && resumeSessionId !== '') {
      const historyMessages = loadSessionHistory(sessionId, cwd);
      if (historyMessages.length > 0) {
        messagesForApi = [...historyMessages, { role: 'user', content: userContent }];
        console.log('[DEBUG] Loaded', historyMessages.length, 'history messages for session continuity');
      }
    }

    const systemMsg = {
      type: 'system',
      subtype: 'init',
      cwd: workingDirectory,
      session_id: sessionId,
      tools: [],
      mcp_servers: [],
      model: modelId,
      permissionMode: permissionMode || 'default',
      apiKeySource: 'ANTHROPIC_API_KEY',
      uuid: randomUUID()
    };
    console.log('[MESSAGE]', JSON.stringify(systemMsg));

    console.log('[DEBUG] Calling messages.create() with non-streaming API...');

    const response = await client.messages.create({
      model: modelId,
      max_tokens: 8192,
      messages: messagesForApi
    });

    console.log('[DEBUG] API response received');

    if (response.error || response.type === 'error') {
      const errorMsg = response.error?.message || response.message || 'Unknown API error';
      console.error('[API_ERROR]', errorMsg);

      const errorContent = [{
        type: 'text',
        text: `API error: ${errorMsg}

Possible causes:
1. API Key is not configured correctly
2. Third-party proxy service configuration issue
3. Please check the configuration in ~/.claude/settings.json`
      }];

      const assistantMsg = {
        type: 'assistant',
        message: {
          id: randomUUID(),
          model: modelId,
          role: 'assistant',
          stop_reason: 'error',
          type: 'message',
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0
          },
          content: errorContent
        },
        session_id: sessionId,
        uuid: randomUUID()
      };
      console.log('[MESSAGE]', JSON.stringify(assistantMsg));
      console.log('[CONTENT]', truncateErrorContent(errorContent[0].text));

      const resultMsg = {
        type: 'result',
        subtype: 'error',
        is_error: true,
        duration_ms: 0,
        num_turns: 1,
        result: errorContent[0].text,
        session_id: sessionId,
        total_cost_usd: 0,
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        uuid: randomUUID()
      };
      console.log('[MESSAGE]', JSON.stringify(resultMsg));
      console.log('[MESSAGE_END]');
      console.log(JSON.stringify({ success: false, error: errorMsg }));
      return;
    }

    const respContent = response.content || [];
    const usage = response.usage || {};

    const assistantMsg = {
      type: 'assistant',
      message: {
        id: response.id || randomUUID(),
        model: response.model || modelId,
        role: 'assistant',
        stop_reason: response.stop_reason || 'end_turn',
        type: 'message',
        usage: {
          input_tokens: usage.input_tokens || 0,
          output_tokens: usage.output_tokens || 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0
        },
        content: respContent
      },
      session_id: sessionId,
      uuid: randomUUID()
    };
    console.log('[MESSAGE]', JSON.stringify(assistantMsg));

    persistJsonlMessage(sessionId, cwd, {
      type: 'assistant',
      message: { content: respContent }
    });

    for (const block of respContent) {
      if (block.type === 'text') {
        console.log('[CONTENT]', truncateErrorContent(block.text));
      }
    }

    const resultMsg = {
      type: 'result',
      subtype: 'success',
      is_error: false,
      duration_ms: 0,
      num_turns: 1,
      result: respContent.map(b => b.type === 'text' ? b.text : '').join(''),
      session_id: sessionId,
      total_cost_usd: 0,
      usage: {
        input_tokens: usage.input_tokens || 0,
        output_tokens: usage.output_tokens || 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0
      },
      uuid: randomUUID()
    };
    console.log('[MESSAGE]', JSON.stringify(resultMsg));

    console.log('[MESSAGE_END]');
    console.log(JSON.stringify({ success: true, sessionId }));

  } catch (error) {
    console.error('[SEND_ERROR]', error.message);
    if (error.response) {
      console.error('[ERROR_DETAILS] Status:', error.response.status);
      console.error('[ERROR_DETAILS] Data:', JSON.stringify(error.response.data));
    }
  }
}
