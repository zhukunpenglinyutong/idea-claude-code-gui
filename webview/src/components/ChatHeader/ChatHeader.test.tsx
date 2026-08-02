import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ChatHeader } from './ChatHeader';
import { makeTestT } from '../../test/i18n';

const t = makeTestT('zh') as never;

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string | Record<string, unknown>) => {
      if (fallback && typeof fallback === 'object') {
        return fallback.defaultValue ?? key;
      }
      return typeof fallback === 'string' ? fallback : key;
    },
  }),
}));

describe('ChatHeader WeChat entry', () => {
  it('appears immediately left of Settings and shows a status dot', () => {
    render(
      <ChatHeader
        currentView="chat"
        sessionTitle="AI2"
        t={t}
        onBack={() => undefined}
        onNewSession={() => undefined}
        onNewTab={() => undefined}
        onHistory={() => undefined}
        onSettings={() => undefined}
        wechatState="BOUND_CURRENT_TAB"
        onWechatClick={() => undefined}
      />,
    );
    const wechat = screen.getByLabelText('微信远程');
    const buttons = screen.getAllByRole('button');
    const wechatIndex = buttons.indexOf(wechat);
    const settingsIndex = buttons.findIndex((button) => button.querySelector('.codicon-settings-gear') !== null);
    expect(wechatIndex).toBeGreaterThanOrEqual(0);
    expect(settingsIndex).toBeGreaterThanOrEqual(0);
    expect(wechatIndex).toBeLessThan(settingsIndex);
    expect(wechat.querySelector('.wechat-status-dot.dot-ok')).not.toBeNull();
  });

  it('clicking the entry invokes the callback', () => {
    const onClick = vi.fn();
    render(
      <ChatHeader
        currentView="chat"
        sessionTitle="AI2"
        t={t}
        onBack={() => undefined}
        onNewSession={() => undefined}
        onNewTab={() => undefined}
        onHistory={() => undefined}
        onSettings={() => undefined}
        onWechatClick={onClick}
      />,
    );
    fireEvent.click(screen.getByLabelText('微信远程'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('the entry exposes a human-readable state title, not color only', () => {
    render(
      <ChatHeader
        currentView="chat"
        sessionTitle="AI2"
        t={t}
        onBack={() => undefined}
        onNewSession={() => undefined}
        onNewTab={() => undefined}
        onHistory={() => undefined}
        onSettings={() => undefined}
        wechatState="BOUND_CURRENT_TAB"
        onWechatClick={() => undefined}
      />,
    );
    const wechat = screen.getByLabelText('微信远程');
    expect(wechat.getAttribute('title')).toBe('微信远程已绑定当前标签页');
  });

  it('the entry title follows the English locale', () => {
    render(
      <ChatHeader
        currentView="chat"
        sessionTitle="AI2"
        t={makeTestT('en') as never}
        onBack={() => undefined}
        onNewSession={() => undefined}
        onNewTab={() => undefined}
        onHistory={() => undefined}
        onSettings={() => undefined}
        wechatState="BOUND_CURRENT_TAB"
        onWechatClick={() => undefined}
      />,
    );
    const wechat = screen.getByLabelText('WeChat Remote');
    expect(wechat.getAttribute('title')).toBe('WeChat Remote bound to current tab');
    expect(wechat.getAttribute('title')).not.toContain('wechat.');
  });

  it('the entry title follows the Traditional Chinese locale', () => {
    render(
      <ChatHeader
        currentView="chat"
        sessionTitle="AI2"
        t={makeTestT('zh-TW') as never}
        onBack={() => undefined}
        onNewSession={() => undefined}
        onNewTab={() => undefined}
        onHistory={() => undefined}
        onSettings={() => undefined}
        wechatState="BOUND_CURRENT_TAB"
        onWechatClick={() => undefined}
      />,
    );
    const wechat = screen.getByLabelText('微信遠端');
    expect(wechat.getAttribute('title')).toBe('微信遠端已綁定目前標籤頁');
  });
});
