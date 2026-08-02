import { FIXED_ILINK_BASE_URL, type QrStatus, type QrStatusResponse } from './types.js';
import { ILinkClient } from './client.js';
import { CredentialStore, type BotCredentials } from './store.js';

export interface QrAuthorizerDeps {
  /** Creates a client for a given API base URL (QR polling may switch hosts). */
  readonly createClient: (baseUrl: string) => ILinkClient;
  readonly store: CredentialStore;
  /** Renders/prints the login URL (`qrcode_img_content`). */
  readonly display: (url: string) => void | Promise<void>;
  /** Reads a verify code line from the user when `need_verifycode`. */
  readonly readVerifyCode: (prompt: string) => Promise<string>;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly timeoutMs?: number;
  readonly maxRefresh?: number;
  /** Live status observation (wait/scaned/confirmed/expired/need_verifycode/...). */
  readonly onStatus?: (status: string) => void;
  /** External cancellation signal; aborts the in-flight long poll immediately. */
  readonly signal?: AbortSignal;
  /** When true, the login loop exits immediately (explicit cancel). */
  readonly isCancelled?: () => boolean;
}

export interface QrResult {
  readonly ok: boolean;
  readonly message: string;
  readonly credentials?: BotCredentials;
  readonly alreadyConnected?: boolean;
}

const DEFAULT_TIMEOUT_MS = 480_000;
const POLL_INTERVAL_MS = 1_000;
const QR_LONG_POLL_MS = 35_000;

/**
 * Official QR login loop (`login-qr.ts` semantics):
 * fixed base `https://ilinkai.weixin.qq.com`, bot_type=3, up to 3 QR
 * refreshes, verify-code prompt, IDC redirect switch, `binded_redirect` is a
 * success, `confirmed` persists credentials atomically.
 */
export async function runQrAuthorization(deps: QrAuthorizerDeps): Promise<QrResult> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const maxRefresh = deps.maxRefresh ?? 3;
  const deadline = Date.now() + (deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let baseUrl = FIXED_ILINK_BASE_URL;
  let client = deps.createClient(baseUrl);
  const existing = await deps.store.loadBotCredentials();
  const localTokenList = existing === undefined ? [] : [existing.botToken];
  let qrcode: string | undefined;
  let refreshCount = 0;

  const fetchQr = async (): Promise<boolean> => {
    try {
      const qr = await client.getQrCode(
        localTokenList,
        deps.signal === undefined ? {} : { signal: deps.signal },
      );
      if (qr.qrcode === undefined || qr.qrcode_img_content === undefined) {
        return false;
      }
      qrcode = qr.qrcode;
      try {
        await deps.display(qr.qrcode_img_content);
      } catch {
        // Display/link-file saving is best-effort; never abort authorization.
      }
      return true;
    } catch {
      return false;
    }
  };

  if (!(await fetchQr())) {
    return { ok: false, message: '获取二维码失败，请检查网络后重试' };
  }

  let verifyCode: string | undefined;
  let scanned = false;
  while (Date.now() < deadline) {
    if (deps.isCancelled?.() || deps.signal?.aborted) {
      return { ok: false, message: 'cancelled' };
    }
    const status = await pollQrStatus(client, qrcode, verifyCode, deps.signal);
    deps.onStatus?.(status.status ?? 'wait');
    switch (status.status) {
      case 'wait':
        break;
      case 'scaned':
        verifyCode = undefined;
        scanned = true;
        break;
      case 'need_verifycode': {
        verifyCode = await deps.readVerifyCode(
          scanned ? '输入的数字不匹配，请重新输入手机微信显示的数字：' : '请输入手机微信显示的数字：',
        );
        continue;
      }
      case 'expired':
      case 'verify_code_blocked': {
        refreshCount += 1;
        if (refreshCount > maxRefresh) {
          return { ok: false, message: '二维码多次失效，请稍后再试' };
        }
        if (!(await fetchQr())) {
          return { ok: false, message: '刷新二维码失败' };
        }
        scanned = false;
        verifyCode = undefined;
        break;
      }
      case 'scaned_but_redirect': {
        if (status.redirect_host !== undefined) {
          baseUrl = `https://${status.redirect_host}`;
          client = deps.createClient(baseUrl);
        }
        break;
      }
      case 'binded_redirect':
        return { ok: true, alreadyConnected: true, message: '该微信已绑定过当前 Adapter，无需重复扫码' };
      case 'confirmed': {
        if (status.ilink_bot_id === undefined || status.bot_token === undefined) {
          return { ok: false, message: '扫码确认但服务端未返回完整凭据' };
        }
        const credentials: BotCredentials = {
          botAccountId: status.ilink_bot_id,
          botToken: status.bot_token,
          baseUrl: status.baseurl ?? FIXED_ILINK_BASE_URL,
          authorizedWeixinUserId: status.ilink_user_id,
          savedAt: Date.now(),
        };
        await deps.store.saveBotCredentials(credentials);
        return { ok: true, message: '扫码授权成功', credentials };
      }
      default:
        break;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  return { ok: false, message: '扫码超时，请重试' };
}

async function pollQrStatus(
  client: ILinkClient,
  qrcode: string | undefined,
  verifyCode: string | undefined,
  signal?: AbortSignal,
): Promise<QrStatusResponse> {
  if (qrcode === undefined) {
    return { status: 'wait' };
  }
  try {
    return await client.getQrCodeStatus(qrcode, verifyCode, {
      timeoutMs: QR_LONG_POLL_MS,
      ...(signal === undefined ? {} : { signal }),
    });
  } catch {
    // Official behavior: network/gateway errors are treated as "wait" and retried.
    return { status: 'wait' };
  }
}

export type { QrStatus };
export { FIXED_ILINK_BASE_URL, ILINK_BOT_TYPE } from './types.js';
