/**
 * Gemini / Antigravity CLI message service.
 * Claude-shaped stdin contract; headless agy stream-json transport.
 */

import { runAgyTurn } from './agy-runner.js';
import { AgyEventNormalizer } from './agy-event-normalizer.js';
import { buildErrorPayload, isAgyAvailable, resolveAgyBinary, warmAgyModelCatalogForModel } from './agy-utils.js';
import { selectWorkingDirectory } from '../../utils/path-utils.js';
import {
  buildReadPathPromptWithImages,
  cleanupMaterializedImagePaths,
  GROK_MAX_IMAGE_BYTES,
  isImageAttachment,
  materializeImageAttachments,
} from '../../utils/cli-image-input.js';

/**
 * @param {object|string} messageOrOptions Claude-shaped options bag or plain message
 */
export async function sendMessage(messageOrOptions, sessionId = '', cwd = '', permissionMode = '', model = '') {
  const opts =
    messageOrOptions && typeof messageOrOptions === 'object' && !Array.isArray(messageOrOptions)
      ? messageOrOptions
      : {
          message: messageOrOptions,
          sessionId,
          cwd,
          permissionMode,
          model,
        };

  const {
    message = '',
    sessionId: sid = '',
    cwd: workCwd = '',
    permissionMode: perm = '',
    model: modelId = '',
    agentPrompt = '',
    reasoningEffort = '',
    agent = '',
    printTimeout = '',
  } = opts;

  const normalizer = new AgyEventNormalizer({
    log: (...args) => console.log(...args),
    error: (...args) => console.error(...args),
  });

  let imagePaths = [];
  try {
    if (!isAgyAvailable()) {
      throw new Error(
        'Antigravity CLI (agy) not found. Install: https://antigravity.google/docs/cli/install '
        + 'or set AGY_PATH to the binary.'
      );
    }

    const guardedCwd = selectWorkingDirectory(workCwd);

    console.error('[DEBUG] Gemini/agy sendMessage:', {
      bin: resolveAgyBinary(),
      hasSessionId: !!sid,
      cwd: guardedCwd || '(current)',
      model: modelId || '(default)',
      permissionMode: perm || '(default)',
      reasoningEffort: reasoningEffort || '(none)',
      hasAgentPrompt: !!agentPrompt,
    });

    normalizer.begin();

    // Optional agent role preamble (agy has no separate system prompt flag in headless)
    let finalMessage = String(message ?? '').trim();
    if (agentPrompt && String(agentPrompt).trim()) {
      finalMessage = finalMessage
        ? `${finalMessage}\n\n## Agent Role and Instructions\n\n${agentPrompt}`
        : `## Agent Role and Instructions\n\n${agentPrompt}`;
    }

    if (!finalMessage.trim()) {
      if (Array.isArray(opts.attachments) && opts.attachments.length > 0) {
        finalMessage = 'Please analyze the attached content.';
      } else {
        finalMessage = 'Continue';
      }
    }

    // agy headless has no multimodal flag: materialize images to temp files
    // and inject Read-tool references (same pattern as pi/omp). Non-image
    // entries are skipped by materializeImageAttachments — say so instead
    // of silently dropping the user's attachment.
    if (Array.isArray(opts.attachments) && opts.attachments.length > 0) {
      // Shared acceptance predicate — the counter must agree with what the
      // materializer actually delivers (mediaType hints, data-URL mimes and
      // att.path entries are images too), or valid attachments get
      // misreported as "non-image … not delivered".
      const nonImage = opts.attachments.filter((a) => !isImageAttachment(a)).length;
      try {
        imagePaths = await materializeImageAttachments(opts.attachments);
        // Distinguish WHY an attachment was not delivered — a valid image
        // over the size limit must not be told "not an image file". The limit
        // text derives from the enforced constant so they can never diverge.
        const maxMb = Math.round(GROK_MAX_IMAGE_BYTES / (1024 * 1024));
        const failedImages = opts.attachments.length - nonImage - imagePaths.length;
        const parts = [];
        if (nonImage > 0) parts.push(`${nonImage} non-image attachment(s)`);
        if (failedImages > 0) {
          parts.push(`${failedImages} image attachment(s) with invalid data or over the ${maxMb} MB limit`);
        }
        if (parts.length > 0) {
          console.error(`[AGY] attachments not delivered: ${parts.join('; ')}`);
          // Surface the skip in the conversation itself — a daemon-only log
          // is invisible to the user, who still sees their attachment chip.
          finalMessage += `\n\n[System note: ${parts.join(' and ')} were not delivered — agy headless turns only support image files up to ${maxMb} MB.]`;
        }
        if (imagePaths.length > 0) {
          finalMessage = buildReadPathPromptWithImages(finalMessage, imagePaths);
        }
      } catch (err) {
        console.error('[AGY] failed to materialize image attachments:', err?.message || err);
        // Same visibility rule as the skip note above: the user's attachment
        // chips are gone and the model never sees the images — say so.
        finalMessage += '\n\n[System note: image attachments could not be delivered — materialization failed.]';
      }
    }

    // Warm the families catalog for bare family ids — the one-shot
    // channel-manager process never sees a listModels process's cache,
    // while the long-lived daemon keeps the module cache until restart
    // (no TTL — staleness is tracked in deferred-work). Without a warm
    // catalog the spawn path guesses a -high suffix.
    await warmAgyModelCatalogForModel(modelId);

    const turn = await runAgyTurn({
      message: finalMessage,
      sessionId: sid,
      cwd: guardedCwd,
      model: modelId,
      reasoningEffort,
      agent,
      permissionMode: perm,
      printTimeout,
      onEvent: (obj) => normalizer.handleStreamEvent(obj),
      onStderr: (chunk) => {
        const s = String(chunk || '').trim();
        if (s) console.error('[AGY]', s.slice(0, 500));
      },
    });

    const st = String(turn.status || '').toUpperCase();
    const text = turn.response || normalizer.assistantText || '';

    if (st && st !== 'SUCCESS' && !text) {
      throw new Error(turn.error || `agy status=${st}`);
    }

    if (st && st !== 'SUCCESS' && text) {
      console.error('[AGY] terminal status', st, turn.error || '');
    }

    normalizer.finishSuccess(turn.conversationId || sid, text);
  } catch (error) {
    console.error('[DEBUG] Gemini/agy error:', error?.message || error);
    normalizer.finishError(error);
  } finally {
    await cleanupMaterializedImagePaths(imagePaths);
  }
}

export { buildErrorPayload };
