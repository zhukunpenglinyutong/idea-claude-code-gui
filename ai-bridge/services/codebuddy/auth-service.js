/** CodeBuddy authentication status helpers. */
import { loadCodeBuddySdk, requireSdk } from '../../utils/sdk-loader.js';
import { resolveCodeBuddyCliPath } from '../../utils/cli-path.js';

// A status check must never open an interactive login flow. The SDK first
// returns the cached account when one exists; otherwise this short timeout
// lets us report that the user needs to run `codebuddy cli` themselves.
const AUTH_STATUS_TIMEOUT_MS = 4000;

/**
 * Map an authentication failure to a stable error code. Timeouts (SDK `code`
 * "timeout" or a "timed out" message) become CODEBUDDY_AUTH_CHECK_TIMEOUT;
 * anything else (including a real "authentication failed" root cause) is
 * surfaced as CODEBUDDY_AUTH_CHECK_FAILED rather than being swallowed.
 */
export function classifyAuthError(error) {
  const code = error?.code || error?.type;
  const errorMessage = error?.message || String(error);
  if (code === 'timeout' || /timed out/i.test(errorMessage)) {
    return {
      success: false,
      authenticated: false,
      errorCode: 'CODEBUDDY_AUTH_CHECK_TIMEOUT',
      error: errorMessage,
    };
  }
  return {
    success: false,
    authenticated: false,
    errorCode: 'CODEBUDDY_AUTH_CHECK_FAILED',
    error: errorMessage,
  };
}

export async function getAuthStatus() {
  try {
    requireSdk('codebuddy');
    const sdk = await loadCodeBuddySdk();
    const authenticate = sdk?.unstable_v2_authenticate
      || sdk?.default?.unstable_v2_authenticate;
    if (typeof authenticate !== 'function') {
      return { success: false, authenticated: false, errorCode: 'AUTH_API_UNAVAILABLE' };
    }

    const result = await authenticate({
      pathToCodebuddyCode: resolveCodeBuddyCliPath() || undefined,
      timeout: AUTH_STATUS_TIMEOUT_MS,
      onAuthUrl: async () => {
        // Intentionally do not open or print the login URL during a status
        // probe. Authorization is only granted after the user logs in via CLI.
      },
    });
    const userinfo = result?.userinfo;
    return {
      success: true,
      authenticated: Boolean(userinfo?.userId && userinfo?.token),
      userName: userinfo?.userName || userinfo?.userNickname || '',
    };
  } catch (error) {
    return classifyAuthError(error);
  }
}
