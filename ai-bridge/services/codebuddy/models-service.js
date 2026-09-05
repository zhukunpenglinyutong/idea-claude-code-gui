import { loadCodeBuddySdk, requireSdk } from '../../utils/sdk-loader.js';
import { resolveCodeBuddyCliPath } from '../../utils/cli-path.js';

const MODEL_DISCOVERY_TIMEOUT_MS = 15_000;
const VALID_REASONING_EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

function emit(payload) {
  console.log(JSON.stringify({ provider: 'codebuddy', ...payload }));
}

function normalizeReasoningEfforts(model) {
  const reasoning = model?.reasoning;
  const raw = model?.supportedEfforts
    || reasoning?.supportedEfforts
    || reasoning?.efforts;
  if (!Array.isArray(raw)) return undefined;
  const efforts = raw
    .map(effort => typeof effort === 'string' ? effort : effort?.id)
    .map(effort => typeof effort === 'string' ? effort.trim().toLowerCase() : '')
    .filter(effort => VALID_REASONING_EFFORTS.has(effort));
  return [...new Set(efforts)];
}

/** Prefix the CodeBuddy SDK uses for models defined in the local models.json. */
const CUSTOM_LOCAL_PREFIX = 'custom-local:';

/**
 * Normalize the SDK's "custom-local:<id>" catalog id to the plain models.json
 * id. The plain id is what gets persisted (selection, session restore) and
 * what the SDK accepts on send, so a prefixed id must never reach the UI.
 */
export function stripCustomLocalPrefix(id) {
  return typeof id === 'string' && id.startsWith(CUSTOM_LOCAL_PREFIX)
    ? id.slice(CUSTOM_LOCAL_PREFIX.length)
    : id;
}

export function normalizeCodeBuddyModels(rawModels) {
  if (!Array.isArray(rawModels)) return [];
  return rawModels.map(model => {
    const supportedEfforts = normalizeReasoningEfforts(model);
    return {
      id: stripCustomLocalPrefix(model?.modelId || model?.id),
      label: model?.name || model?.label || stripCustomLocalPrefix(model?.modelId) || model?.id,
      description: model?.description,
      credits: model?.credits,
      ...(typeof model?.supportsReasoning === 'boolean'
        ? { reasoningSupported: model.supportsReasoning }
        : {}),
      ...(supportedEfforts?.length ? { supportedEfforts } : {}),
    };
  }).filter(model => typeof model.id === 'string' && model.id.trim());
}

/** Load the model catalog exposed by the CodeBuddy Agent SDK. */
export async function listModels() {
  let sessionHandle;
  let queryHandle;
  let discoveryTimer;
  const abortController = new AbortController();
  try {
    requireSdk('codebuddy');
    const sdk = await loadCodeBuddySdk();
    const createSession = sdk?.unstable_v2_createSession
      || sdk?.default?.unstable_v2_createSession;
    const query = sdk?.query
      || (typeof sdk?.default === 'function' ? sdk.default : sdk?.default?.query);
    const codeBuddyCliPath = resolveCodeBuddyCliPath();
    const options = {
      cwd: process.cwd(),
      permissionMode: 'default',
      persistSession: false,
      settingSources: ['user', 'project', 'local'],
      abortController,
      ...(codeBuddyCliPath ? { pathToCodebuddyCode: codeBuddyCliPath } : {}),
    };
    const timeout = new Promise((_, reject) => {
      discoveryTimer = setTimeout(() => {
        abortController.abort();
        reject(new Error('CodeBuddy model discovery timed out. Please check CodeBuddy authentication.'));
      }, MODEL_DISCOVERY_TIMEOUT_MS);
    });

    let discoveryPromise;
    if (typeof createSession === 'function') {
      sessionHandle = await createSession(options);
      const getModels = sessionHandle?.getAvailableModelsRaw || sessionHandle?.getAvailableModels;
      if (typeof getModels !== 'function') {
        throw new Error('CodeBuddy Agent SDK model discovery is not available.');
      }
      discoveryPromise = getModels.call(sessionHandle);
    } else if (typeof query === 'function') {
      queryHandle = query({ prompt: '', options: { ...options, abortController } });
      const getModels = queryHandle?.getAvailableModels || queryHandle?.supportedModels;
      if (typeof getModels !== 'function') {
        throw new Error('CodeBuddy Agent SDK model discovery is not available.');
      }
      discoveryPromise = (async () => {
        if (typeof queryHandle.connect === 'function') await queryHandle.connect();
        return getModels.call(queryHandle);
      })();
    } else {
      throw new Error('CodeBuddy Agent SDK model API not available. Please reinstall dependencies.');
    }

    const discovered = await Promise.race([discoveryPromise, timeout]);
    // After the race settles, a late rejection of the losing promise must not
    // become an unhandledRejection (it would print a second JSON line that
    // CliModelsHandler could misread as the result).
    discoveryPromise.catch(() => {});
    const models = normalizeCodeBuddyModels(discovered);
    emit({ success: true, defaultModel: models[0]?.id || null, models });
  } catch (error) {
    emit({
      success: false,
      defaultModel: null,
      models: [],
      error: error?.message || String(error),
    });
  } finally {
    if (discoveryTimer) clearTimeout(discoveryTimer);
    if (sessionHandle && typeof sessionHandle.close === 'function') {
      try {
        // Bounded like the queryHandle.interrupt() below: a wedged close must
        // not pin the bridge process past the caller's overall timeout.
        await Promise.race([
          sessionHandle.close(),
          new Promise(resolve => setTimeout(resolve, 2_000)),
        ]);
      } catch {
        // The session may already have closed after model discovery. Cleanup
        // must never turn a valid result into an unhandled rejection.
      }
    }
    if (queryHandle && typeof queryHandle.interrupt === 'function') {
      try {
        await Promise.race([
          queryHandle.interrupt(),
          new Promise(resolve => setTimeout(resolve, 2_000)),
        ]);
      } catch {
        // The SDK may already have closed the query after model discovery.
      }
    }
  }
}
