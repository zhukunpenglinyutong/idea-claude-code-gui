/**
 * Discover MiniMax Code models from ~/.minimax/config.yaml.
 *
 * Structure (verified with mcode 0.2.x):
 *   provider:
 *     minimax:
 *       name: MiniMax
 *       models:
 *         MiniMax-M3: {...}
 *   custom_provider:
 *     provider-xxx:
 *       name: <display>
 *       enabled: true
 *       models:
 *         <model-id>: {...}
 *   defaultModel: <provider>/<model> | custom_provider:<key>/<model>
 *
 * Model references passed to `mcode exec --model` use
 * `minimax/<model>` and `custom_provider:<key>/<model>`.
 */

import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

function resolveMiniMaxConfigPaths() {
  const home = process.env.MINIMAX_CODE_HOME
    || process.env.MINIMAX_HOME
    || join(homedir(), '.minimax');
  return [
    join(home, 'config.yaml'),
    join(homedir(), '.minimax', 'config.yaml'),
  ].filter((path) => {
    try {
      return existsSync(path);
    } catch {
      return false;
    }
  });
}

function parseScalar(line) {
  const match = line.trim().match(/^[A-Za-z_][\w-]*:\s*(.*)$/);
  if (!match) return null;
  const raw = match[1].trim();
  if (!raw) return null;
  const quoted = raw.match(/^['"](.*)['"]$/);
  return (quoted ? quoted[1] : raw).trim();
}

function isMappingKey(line) {
  // Custom-provider model ids may start with a digit (e.g. "7b-instruct").
  return /^[A-Za-z0-9_][\w.-]*:\s*$/.test(line.trim()) && line.trim().endsWith(':');
}

/**
 * Line-based extractor for provider/custom_provider model sections.
 * @param {string} text config.yaml content
 */
export function parseMiniMaxModelsFromYaml(text) {
  const lines = String(text || '').split(/\r?\n/);
  const models = [];
  const seen = new Set();
  let defaultModel = null;

  // section: 0 = none, 1 = under provider:, 2 = under custom_provider:
  let section = 0;
  let providerKey = '';
  let providerName = '';
  let inModels = false;

  const pushModel = (id) => {
    if (!id) return;
    const ref = section === 2 ? `custom_provider:${providerKey}/${id}` : `${providerKey}/${id}`;
    if (seen.has(ref)) return;
    seen.add(ref);
    const label = providerName && providerName !== providerKey
      ? `${providerName} / ${id}`
      : ref;
    models.push({ id: ref, label, description: ref });
  };

  for (const rawLine of lines) {
    if (!rawLine.trim() || rawLine.trim().startsWith('#')) continue;
    const indent = rawLine.length - rawLine.trimStart().length;

    if (indent === 0) {
      section = 0;
      inModels = false;
      const key = rawLine.trim();
      if (key === 'provider:') {
        section = 1;
      } else if (key === 'custom_provider:') {
        section = 2;
      } else if (key.startsWith('defaultModel:')) {
        const value = parseScalar(rawLine);
        if (value) defaultModel = value;
      }
      continue;
    }

    if (section === 0) continue;

    if (indent === 2) {
      inModels = false;
      if (!isMappingKey(rawLine)) continue;
      providerKey = rawLine.trim().slice(0, -1).trim();
      // strip quoted keys
      providerName = providerKey;
      continue;
    }

    if (indent === 4) {
      inModels = rawLine.trim() === 'models:';
      // provider display name lives at indent 4 under the provider key
      if (!inModels && /^name:/.test(rawLine.trim())) {
        const value = parseScalar(rawLine);
        if (value) providerName = value;
      }
      continue;
    }

    if (inModels && indent === 6 && isMappingKey(rawLine)) {
      pushModel(rawLine.trim().slice(0, -1).trim());
    }
  }

  return { defaultModel, models };
}

/**
 * Prints JSON model list for channel-manager listModels.
 */
export function listModels() {
  const paths = resolveMiniMaxConfigPaths();
  let models = [];
  let defaultModel = null;

  for (const path of paths) {
    try {
      const text = readFileSync(path, 'utf8');
      const parsed = parseMiniMaxModelsFromYaml(text);
      if (parsed.models.length > 0) {
        models = parsed.models;
        defaultModel = parsed.defaultModel;
        break;
      }
    } catch {
      // try next path
    }
  }

  const result = [
    { id: 'auto', label: 'MiniMax Auto', description: 'Use MiniMax Code default model' },
    ...models,
  ];

  console.log(JSON.stringify({
    success: true,
    provider: 'minimax',
    defaultModel: defaultModel || 'auto',
    models: result,
  }));
}
