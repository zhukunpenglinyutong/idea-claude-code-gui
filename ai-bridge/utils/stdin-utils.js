/**
 * Stdin reader utility module (unified version).
 * Supports Claude SDK, Codex SDK, and CLI channels (Grok / Kimi / OpenCode).
 */

const STDIN_ENV_BY_PROVIDER = {
  codex: 'CODEX_USE_STDIN',
  grok: 'GROK_USE_STDIN',
  kimi: 'KIMI_USE_STDIN',
  opencode: 'OPENCODE_USE_STDIN',
  pi: 'PI_USE_STDIN',
  omp: 'OMP_USE_STDIN',
  dsh: 'DSH_USE_STDIN',
  mimo: 'MIMO_USE_STDIN',
};

/**
 * @param {string} provider
 * @returns {string}
 */
function stdinEnvKeyForProvider(provider) {
  return STDIN_ENV_BY_PROVIDER[provider] || 'CLAUDE_USE_STDIN';
}

/**
 * Read JSON data from stdin.
 * @param {string} provider - 'claude' | 'codex' | 'grok' | 'kimi' | 'opencode'
 * @returns {Promise<Object|null>} The parsed JSON object, or null
 */
export async function readStdinData(provider = 'claude') {
  // Check whether stdin input is enabled
  const envKey = stdinEnvKeyForProvider(provider);
  if (process.env[envKey] !== 'true') {
    return null;
  }

  return new Promise((resolve) => {
    let data = '';
    const stdin = process.stdin;

    stdin.setEncoding('utf8');

    // Cleanup: remove all listeners and stop reading
    const cleanup = () => {
      stdin.removeListener('readable', onReadable);
      stdin.removeListener('end', onEnd);
      stdin.removeListener('error', onError);
      stdin.pause();
    };

    // Set a timeout to avoid waiting indefinitely
    const timeout = setTimeout(() => {
      cleanup();
      resolve(null);
    }, 5000);

    const onReadable = () => {
      let chunk;
      while ((chunk = stdin.read()) !== null) {
        data += chunk;
      }
    };

    const onEnd = () => {
      clearTimeout(timeout);
      cleanup();
      if (data.trim()) {
        try {
          const parsed = JSON.parse(data.trim());
          resolve(parsed);
        } catch (e) {
          console.error('[STDIN_PARSE_ERROR]', e.message);
          resolve(null);
        }
      } else {
        resolve(null);
      }
    };

    const onError = (err) => {
      clearTimeout(timeout);
      cleanup();
      console.error('[STDIN_ERROR]', err.message);
      resolve(null);
    };

    stdin.on('readable', onReadable);
    stdin.on('end', onEnd);
    stdin.on('error', onError);
  });
}
