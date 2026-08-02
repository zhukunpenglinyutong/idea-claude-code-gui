import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { WechatDialog, type WechatDialogProps } from './WechatDialog';
import type { WechatStatusView } from '../../hooks/useWechatRemote';
import { makeTestT, type TestLang } from '../../test/i18n';

function buildView(overrides: Partial<WechatStatusView> = {}): WechatStatusView {
  return {
    processState: 'RUNNING',
    uiState: 'LOGGED_OUT',
    authState: 'UNCONFIGURED',
    ...overrides,
  };
}

function renderDialog(
  view: WechatStatusView,
  onAction = vi.fn(),
  onClose = vi.fn(),
  lang: TestLang = 'zh',
) {
  const props: WechatDialogProps = {
    open: true,
    view,
    t: makeTestT(lang) as never,
    onClose,
    onAction,
  };
  const result = render(<WechatDialog {...props} />);
  return { onAction, onClose, ...result };
}

function qrLogin(
  status = 'QR_PENDING',
  overrides: Partial<NonNullable<WechatStatusView['login']>> = {},
): NonNullable<WechatStatusView['login']> {
  return {
    loginId: 'L1',
    status,
    expiresAt: Date.now() + 60_000,
    verifyCodeRequired: false,
    qrUrl: 'https://qr.example/1',
    qrDataUri: 'data:image/png;base64,AAAA',
    ...overrides,
  };
}

function footerLabels(container: HTMLElement): (string | null)[] {
  return Array.from(container.querySelectorAll('.wechat-dialog-actions button')).map((b) => b.textContent);
}

describe('WechatDialog', () => {
  it('LOGGED_OUT auto-starts exactly one login', () => {
    const { onAction } = renderDialog(buildView({ uiState: 'LOGGED_OUT' }));
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onAction).toHaveBeenCalledWith('wechat_login_start');
  });

  it('closing while a QR login is active cancels the session and closes', () => {
    const { onAction, onClose, container } = renderDialog(
      buildView({ uiState: 'QR_PENDING', login: qrLogin() }),
    );
    fireEvent.click(screen.getByLabelText('关闭'));
    expect(onAction).toHaveBeenCalledWith('wechat_login_cancel', { loginId: 'L1' });
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(container.querySelector('.confirm-dialog-overlay') as HTMLElement, { key: 'Escape' });
    expect(onAction).toHaveBeenCalledWith('wechat_login_cancel', { loginId: 'L1' });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('closing in a connected state only hides (no logout/cancel)', () => {
    const { onAction, onClose } = renderDialog(buildView({ uiState: 'CONNECTED_UNBOUND' }));
    fireEvent.click(screen.getByLabelText('关闭'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onAction).not.toHaveBeenCalled();
  });

  it('normal QR state shows scan prompt, countdown and a single blue refresh', () => {
    const { container } = renderDialog(
      buildView({ uiState: 'QR_PENDING', login: qrLogin() }),
    );
    expect(screen.getByText('使用微信扫码连接')).not.toBeNull();
    expect(screen.getByText(/打开手机微信扫描二维码/)).not.toBeNull();
    expect(screen.getByText(/二维码将在 .+ 后自动刷新/)).not.toBeNull();
    expect(footerLabels(container)).toEqual(['刷新二维码']);
    const refresh = screen.getByText('刷新二维码');
    expect(refresh.classList.contains('confirm-button')).toBe(true);
    expect(screen.queryByText('取消本次登录')).toBeNull();
    expect(screen.queryByText('重新获取二维码')).toBeNull();
  });

  it('expired QR keeps the same single blue refresh action', () => {
    const { container } = renderDialog(
      buildView({ uiState: 'QR_PENDING', login: qrLogin('EXPIRED') }),
    );
    expect(footerLabels(container)).toEqual(['刷新二维码']);
    expect(screen.queryByText('重新获取二维码')).toBeNull();
  });

  it('manual refresh shows a busy label and disables the button', () => {
    const { onAction, container } = renderDialog(
      buildView({ uiState: 'QR_PENDING', login: qrLogin() }),
    );
    fireEvent.click(screen.getByText('刷新二维码'));
    expect(onAction).toHaveBeenCalledWith('wechat_login_refresh');
    expect(screen.getByText('刷新中…')).not.toBeNull();
    expect((screen.getByText('刷新中…') as HTMLButtonElement).disabled).toBe(true);
    expect(container.querySelector('.wechat-dialog')?.getAttribute('aria-busy')).toBe('true');
  });

  it('scanned state weakens the QR and keeps the single refresh action', () => {
    const { container } = renderDialog(buildView({ uiState: 'SCANNED', login: qrLogin('SCANNED') }));
    expect(screen.getByText('已扫码，请在手机微信中确认登录。')).not.toBeNull();
    expect(footerLabels(container)).toEqual(['刷新二维码']);
  });

  it('verify-code state submits the pairing code as a primary action', () => {
    const { onAction, container } = renderDialog(
      buildView({ uiState: 'VERIFY_CODE_REQUIRED', login: qrLogin('VERIFY_CODE_REQUIRED') }),
    );
    expect(screen.getByText('输入手机微信中显示的配对码。')).not.toBeNull();
    expect(footerLabels(container)).toEqual(['刷新二维码', '确认配对码']);
    const confirm = screen.getByText('确认配对码');
    expect(confirm.classList.contains('confirm-button')).toBe(true);
    fireEvent.change(screen.getByLabelText('配对码'), { target: { value: '123456' } });
    fireEvent.click(confirm);
    expect(onAction).toHaveBeenCalledWith('wechat_login_verify', { loginId: 'L1', code: '123456' });
    expect(screen.getByText('处理中…')).not.toBeNull();
  });

  it('bound current and bound other render differently', () => {
    const first = renderDialog(buildView({ uiState: 'BOUND_CURRENT_TAB' }));
    expect(first.container.textContent).toContain('微信远程已绑定当前标签页');
    first.unmount();
    const second = renderDialog(buildView({ uiState: 'BOUND_OTHER_TAB' }));
    expect(second.container.textContent).toContain('微信当前绑定到其他标签页');
  });

  it('bound other offers rebind-to-current and keep-binding, never the vague label', () => {
    const { container } = renderDialog(buildView({ uiState: 'BOUND_OTHER_TAB' }));
    expect(screen.getByText('改绑到当前标签页')).not.toBeNull();
    expect(screen.getByText('保持当前绑定')).not.toBeNull();
    expect(screen.queryByText('绑定当前标签页')).toBeNull();
    expect(footerLabels(container)).toEqual(['退出登录', '保持当前绑定', '改绑到当前标签页']);
  });

  it('rebind requires confirmation and hides unrelated actions', () => {
    const { onAction, container } = renderDialog(buildView({ uiState: 'BOUND_OTHER_TAB' }));
    fireEvent.click(screen.getByText('改绑到当前标签页'));
    expect(onAction).not.toHaveBeenCalledWith('wechat_bind_current');
    expect(screen.getByText('确认改绑')).not.toBeNull();
    expect(screen.getByText('取消')).not.toBeNull();
    expect(footerLabels(container)).toEqual(['取消', '确认改绑']);
    fireEvent.click(screen.getByText('确认改绑'));
    expect(onAction).toHaveBeenCalledWith('wechat_bind_current');
  });

  it('unbind does not logout', () => {
    const { onAction } = renderDialog(buildView({ uiState: 'BOUND_CURRENT_TAB' }));
    fireEvent.click(screen.getByText('解除绑定'));
    expect(onAction).toHaveBeenCalledWith('wechat_unbind');
    expect(onAction).not.toHaveBeenCalledWith('wechat_logout');
  });

  it('connected-unbound hides unbind and shows bind + logout', () => {
    const { container } = renderDialog(buildView({ uiState: 'CONNECTED_UNBOUND' }));
    expect(screen.queryByText('解除绑定')).toBeNull();
    expect(screen.queryByText('解绑')).toBeNull();
    expect(footerLabels(container)).toEqual(['退出登录', '绑定当前标签页']);
  });

  it('target-invalid hides unbind and offers rebind', () => {
    const { container } = renderDialog(buildView({ uiState: 'TARGET_INVALID' }));
    expect(screen.queryByText('解除绑定')).toBeNull();
    expect(footerLabels(container)).toEqual(['退出登录', '绑定当前标签页']);
  });

  it('logout confirmation explains scope, uses a light danger action and closes after logout', () => {
    const { onAction, onClose } = renderDialog(buildView({ uiState: 'BOUND_CURRENT_TAB' }));
    fireEvent.click(screen.getByText('退出登录'));
    expect(screen.getByText('退出登录？')).not.toBeNull();
    expect(screen.getByText('退出后将清除微信登录状态和标签页绑定。')).not.toBeNull();
    expect(screen.getByText(/会话和聊天记录不会受到影响/)).not.toBeNull();
    const logout = screen.getByText('退出登录');
    expect(logout.classList.contains('wechat-danger-button')).toBe(true);
    expect(logout.classList.contains('confirm-button')).toBe(false);
    fireEvent.click(logout);
    expect(onAction).toHaveBeenCalledWith('wechat_logout');
    expect(onClose).toHaveBeenCalled();
  });

  it('Node version guidance shows one primary redetect and no download/connect/retry', () => {
    const props: WechatDialogProps = {
      open: true,
      view: buildView({
        uiState: 'ADAPTER_OFFLINE',
        error: '微信远程需要 Node.js 22 或更高版本；当前检测版本 v20.13.1；当前检测路径 C:\\Program Files\\nodejs\\node.exe',
      }),
      t: makeTestT('zh') as never,
      onClose: vi.fn(),
      onAction: vi.fn(),
    };
    const { container } = render(<WechatDialog {...props} />);
    expect(screen.getByText('需要 Node.js 22 或更高版本')).not.toBeNull();
    expect(screen.getByText(/当前检测版本：v20\.13\.1/)).not.toBeNull();
    expect(screen.getByText(/不会自动下载或修改你的系统环境/)).not.toBeNull();
    expect(screen.queryByText('连接')).toBeNull();
    expect(screen.queryByText('重试')).toBeNull();
    expect(container.querySelectorAll('a').length).toBe(0);
    expect(Array.from(container.querySelectorAll('button')).every((b) => !b.textContent?.includes('下载'))).toBe(true);
    const redetect = screen.getByText('重新检测');
    fireEvent.click(redetect);
    expect(props.onAction).toHaveBeenCalledWith('wechat_retry');
    expect(screen.getByText('检测中…')).not.toBeNull();
    expect((screen.getByText('检测中…') as HTMLButtonElement).disabled).toBe(true);
  });

  it('uses the public overlay mask with the integrated lightweight container', () => {
    const { container } = renderDialog(buildView({ uiState: 'CONNECTED_UNBOUND' }));
    expect(container.querySelector('.confirm-dialog-overlay')).not.toBeNull();
    expect(container.querySelector('.wechat-dialog')).not.toBeNull();
    expect(container.querySelector('.wechat-dialog-header')).not.toBeNull();
    expect(container.querySelector('.wechat-dialog-actions')).not.toBeNull();
    expect(container.querySelector('.confirm-dialog-header')).toBeNull();
    expect(container.querySelector('.confirm-dialog-footer')).toBeNull();
    expect(container.querySelectorAll('.confirm-dialog-button').length).toBeGreaterThan(0);
  });

  it('renders English copy for the Node version guidance', () => {
    const props: WechatDialogProps = {
      open: true,
      view: buildView({
        uiState: 'ADAPTER_OFFLINE',
        error: '微信远程需要 Node.js 22 或更高版本；当前检测版本 v20.13.1；当前检测路径 C:\\Program Files\\nodejs\\node.exe',
      }),
      t: makeTestT('en') as never,
      onClose: vi.fn(),
      onAction: vi.fn(),
    };
    const { container } = render(<WechatDialog {...props} />);
    expect(screen.getByText('Node.js 22 or later is required')).not.toBeNull();
    expect(screen.getByText('Detected version: v20.13.1.')).not.toBeNull();
    expect(screen.getByText('Check Again')).not.toBeNull();
    expect(container.textContent).not.toContain('wechat.');
  });

  it('renders English QR and binding copy', () => {
    const qr = renderDialog(buildView({ uiState: 'QR_PENDING', login: qrLogin() }), vi.fn(), vi.fn(), 'en');
    expect(qr.container.textContent).toContain('Connect with WeChat');
    expect(qr.container.textContent).toMatch(/QR code will refresh in/);
    expect(screen.getByText('Refresh QR code')).not.toBeNull();
    qr.unmount();

    const bound = renderDialog(buildView({ uiState: 'BOUND_OTHER_TAB' }), vi.fn(), vi.fn(), 'en');
    expect(bound.container.textContent).toContain('Rebind to current tab');
    expect(bound.container.textContent).toContain('Keep current binding');
    expect(bound.container.textContent).toContain('Sign out');
    bound.unmount();

    const unbound = renderDialog(buildView({ uiState: 'CONNECTED_UNBOUND' }), vi.fn(), vi.fn(), 'en');
    expect(unbound.container.textContent).toContain('Bind current tab');
    expect(unbound.container.textContent).not.toContain('wechat.');
  });

  it('interpolates the auto-refresh countdown', () => {
    const zh = renderDialog(
      buildView({ uiState: 'QR_PENDING', login: qrLogin('QR_PENDING', { expiresAt: Date.now() + 59_000 }) }),
    );
    expect(zh.container.textContent).toMatch(/二维码将在 \d+:\d{2} 后自动刷新/);
    zh.unmount();
    const en = renderDialog(
      buildView({ uiState: 'QR_PENDING', login: qrLogin('QR_PENDING', { expiresAt: Date.now() + 59_000 }) }),
      vi.fn(),
      vi.fn(),
      'en',
    );
    expect(en.container.textContent).toMatch(/QR code will refresh in \d+:\d{2}/);
  });

  it('does not leak raw translation keys', () => {
    const { container } = renderDialog(buildView({ uiState: 'CONNECTED_UNBOUND' }));
    expect(container.textContent).not.toContain('wechat.');
  });

  it('renders Traditional Chinese copy with interpolation', () => {
    const nodeProps: WechatDialogProps = {
      open: true,
      view: buildView({
        uiState: 'ADAPTER_OFFLINE',
        error: '微信远程需要 Node.js 22 或更高版本；当前检测版本 v20.13.1；当前检测路径 C:\\Program Files\\nodejs\\node.exe',
      }),
      t: makeTestT('zh-TW') as never,
      onClose: vi.fn(),
      onAction: vi.fn(),
    };
    const node = render(<WechatDialog {...nodeProps} />);
    expect(screen.getByText('需要 Node.js 22 或更高版本')).not.toBeNull();
    expect(screen.getByText('目前偵測版本：v20.13.1。')).not.toBeNull();
    node.unmount();

    const qr = renderDialog(
      buildView({ uiState: 'QR_PENDING', login: qrLogin('QR_PENDING', { expiresAt: Date.now() + 59_000 }) }),
      vi.fn(),
      vi.fn(),
      'zh-TW',
    );
    expect(qr.container.textContent).toContain('使用微信掃碼連線');
    expect(qr.container.textContent).toMatch(/QR Code 將在 \d+:\d{2} 後自動重新整理/);
    qr.unmount();

    const bound = renderDialog(buildView({ uiState: 'BOUND_OTHER_TAB' }), vi.fn(), vi.fn(), 'zh-TW');
    expect(bound.container.textContent).toContain('改綁到目前標籤頁');
    expect(bound.container.textContent).toContain('保持目前綁定');
    bound.unmount();

    const unbound = renderDialog(buildView({ uiState: 'CONNECTED_UNBOUND' }), vi.fn(), vi.fn(), 'zh-TW');
    expect(unbound.container.textContent).toContain('綁定目前標籤頁');
    expect(unbound.container.textContent).toContain('退出登入');
    expect(unbound.container.textContent).not.toContain('wechat.');
  });
});
