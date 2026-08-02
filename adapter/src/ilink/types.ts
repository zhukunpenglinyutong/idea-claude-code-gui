/**
 * Minimal iLink protocol DTOs, verified against the official
 * openclaw-weixin 2.4.6 source (`src/api/types.ts`, `src/api/api.ts`,
 * `src/auth/login-qr.ts`) on 2026-08-01.
 */
export const TEXT_ITEM_TYPE = 1;
/** Official `MessageType.USER` — inbound user messages. */
export const MESSAGE_TYPE_USER = 1;
/** Official `MessageType.BOT` — outbound bot messages. */
export const MESSAGE_TYPE_BOT = 2;
/** Official `MessageState.FINISH`. */
export const MESSAGE_STATE_FINISH = 2;
export const MAX_TEXT_CHUNK = 4000;
export const TOKEN_INVALID_RET = -14;
/** Fixed QR API base from `login-qr.ts`. */
export const FIXED_ILINK_BASE_URL = 'https://ilinkai.weixin.qq.com';
/** Official `DEFAULT_ILINK_BOT_TYPE`. */
export const ILINK_BOT_TYPE = '3';
/** Official `ilink_appid` from the plugin package.json. */
export const ILINK_APP_ID = 'bot';

export interface TextItem {
  readonly type: number;
  readonly text_item?: { text: string };
}

export interface InboundRawMessage {
  readonly message_id: string | number;
  readonly seq?: number;
  readonly from_user_id?: string;
  readonly to_user_id?: string;
  readonly client_id?: string;
  readonly message_type?: number;
  readonly message_state?: number;
  readonly session_id?: string;
  readonly item_list?: TextItem[];
  /** Official `WeixinMessage.context_token` — reply routing credential. */
  readonly context_token?: string;
}

export interface GetUpdatesResponse {
  readonly ret: number;
  readonly errcode?: number;
  readonly errmsg?: string;
  readonly msgs?: InboundRawMessage[];
  readonly get_updates_buf?: string;
  readonly longpolling_timeout_ms?: number;
}

export interface SendMessageOut {
  readonly msg: {
    from_user_id: string;
    to_user_id: string;
    client_id: string;
    message_type: number;
    message_state: number;
    context_token?: string;
    item_list: TextItem[];
  };
}

export interface SendMessageResponse {
  readonly ret: number;
  readonly errcode?: number;
  readonly errmsg?: string;
}

export interface QrCodeResponse {
  readonly qrcode?: string;
  /** Login URL shown to the user (official `qrcode_img_content`). */
  readonly qrcode_img_content?: string;
  readonly errcode?: number;
  readonly errmsg?: string;
}

export type QrStatus =
  | 'wait'
  | 'scaned'
  | 'need_verifycode'
  | 'verify_code_blocked'
  | 'confirmed'
  | 'expired'
  | 'scaned_but_redirect'
  | 'binded_redirect';

export interface QrStatusResponse {
  readonly status?: QrStatus;
  readonly bot_token?: string;
  readonly ilink_bot_id?: string;
  readonly baseurl?: string;
  readonly ilink_user_id?: string;
  /** New polling host when status is `scaned_but_redirect`. */
  readonly redirect_host?: string;
  readonly errcode?: number;
  readonly errmsg?: string;
}

export interface GetConfigResponse {
  readonly ret: number;
  readonly typing_ticket?: string;
  readonly errcode?: number;
  readonly errmsg?: string;
}

export interface SendTypingResponse {
  readonly ret: number;
  readonly errcode?: number;
  readonly errmsg?: string;
}

export interface NotifyResponse {
  readonly ret: number;
  readonly errcode?: number;
  readonly errmsg?: string;
}

export function textOf(message: InboundRawMessage): string {
  const texts: string[] = [];
  for (const item of message.item_list ?? []) {
    if (item.type === TEXT_ITEM_TYPE && item.text_item !== undefined) {
      texts.push(item.text_item.text);
    }
  }
  return texts.join('\n');
}

export function isUserTextMessage(message: InboundRawMessage, authorizedUserId: string): boolean {
  return (
    message.message_type === MESSAGE_TYPE_USER &&
    message.from_user_id === authorizedUserId &&
    textOf(message).length > 0
  );
}
