import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AppearanceTab from './AppearanceTab';

const changeLanguageMock = vi.fn();

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: {
      language: 'zh',
      changeLanguage: changeLanguageMock,
    },
  }),
}));

describe('AppearanceTab ui font selector', () => {
  afterEach(() => {
    localStorage.clear();
  });

  const renderAppearanceTab = (overrides: Record<string, unknown> = {}) => render(
    <AppearanceTab
      {...({
        theme: 'dark',
        onThemeChange: vi.fn(),
        fontSizeLevel: 3,
        onFontSizeLevelChange: vi.fn(),
        editorFontConfig: {
          fontFamily: 'Monaco',
          fontSize: 14,
          lineSpacing: 1.35,
        },
        uiFontConfig: {
          mode: 'followEditor',
          effectiveMode: 'followEditor',
          fontFamily: 'Monaco',
          fontSize: 14,
          lineSpacing: 1.35,
        },
        codeFontConfig: {
          mode: 'followEditor',
          effectiveMode: 'followEditor',
          fontFamily: 'Monaco',
          fontSize: 14,
          lineSpacing: 1.35,
        },
        onUiFontSelectionChange: vi.fn(),
        onUiFontCustomPathChange: vi.fn(),
        onSaveUiFontCustomPath: vi.fn(),
        onBrowseUiFontFile: vi.fn(),
        onCodeFontSelectionChange: vi.fn(),
        onSaveCodeFontCustomPath: vi.fn(),
        onBrowseCodeFontFile: vi.fn(),
        ...overrides,
      } as any)}
    />
  );

  it('delegates follow-IDE selection to Java without touching localStorage', () => {
    const sendToJava = vi.fn();
    window.sendToJava = sendToJava;
    localStorage.setItem('languageSelectionMode', 'manual');

    renderAppearanceTab();

    fireEvent.change(screen.getByTestId('settings-language-select'), {
      target: { value: '__follow_idea__' },
    });

    expect(sendToJava).toHaveBeenCalledWith('clear_user_language:');
    expect(changeLanguageMock).not.toHaveBeenCalled();
    // Java + main.tsx own the persisted state; component must not write here.
    expect(localStorage.getItem('languageSelectionMode')).toBe('manual');
  });

  it('delegates manual language selection to Java without touching localStorage', () => {
    const sendToJava = vi.fn();
    window.sendToJava = sendToJava;
    changeLanguageMock.mockClear();
    localStorage.setItem('languageSelectionMode', 'followIdea');

    renderAppearanceTab();

    fireEvent.change(screen.getByTestId('settings-language-select'), {
      target: { value: 'en' },
    });

    expect(sendToJava).toHaveBeenCalledWith(
      'set_user_language:' + JSON.stringify({ language: 'en' })
    );
    expect(changeLanguageMock).toHaveBeenCalledWith('en');
    expect(localStorage.getItem('languageSelectionMode')).toBe('followIdea');
    expect(localStorage.getItem('language')).toBeNull();
  });

  it('resyncs the selection when main.tsx dispatches language-config-applied', () => {
    window.sendToJava = vi.fn();
    localStorage.setItem('languageSelectionMode', 'manual');

    renderAppearanceTab();
    const select = screen.getByTestId('settings-language-select') as HTMLSelectElement;
    expect(select.value).toBe('zh');

    // Simulate Java pushing the authoritative followIdea state after a failure
    // or external config edit.
    act(() => {
      localStorage.setItem('languageSelectionMode', 'followIdea');
      window.dispatchEvent(new CustomEvent('language-config-applied', {
        detail: { language: 'zh', selectionMode: 'followIdea' },
      }));
    });

    expect(select.value).toBe('__follow_idea__');
  });

  it('renders only follow-editor and custom options, plus custom path controls for custom mode', () => {
    const props = {
      theme: 'dark',
      onThemeChange: vi.fn(),
      fontSizeLevel: 3,
      onFontSizeLevelChange: vi.fn(),
      editorFontConfig: {
        fontFamily: 'Monaco',
        fontSize: 14,
        lineSpacing: 1.35,
      },
      uiFontConfig: {
        mode: 'customFile',
        effectiveMode: 'followEditor',
        customFontPath: '/tmp/MapleMono.ttf',
        fontFamily: 'Monaco',
        fontSize: 14,
        lineSpacing: 1.35,
        warning: 'font unavailable, currently using editor font',
      },
      codeFontConfig: {
        mode: 'followEditor',
        effectiveMode: 'followEditor',
        fontFamily: 'Monaco',
        fontSize: 14,
        lineSpacing: 1.35,
      },
      onUiFontSelectionChange: vi.fn(),
      onUiFontCustomPathChange: vi.fn(),
      onSaveUiFontCustomPath: vi.fn(),
      onBrowseUiFontFile: vi.fn(),
      onCodeFontSelectionChange: vi.fn(),
      onSaveCodeFontCustomPath: vi.fn(),
      onBrowseCodeFontFile: vi.fn(),
    } as any;

    render(<AppearanceTab {...props} />);

    const select = screen.getByRole('combobox', { name: /settings.basic.editorFont.label/i });
    const options = within(select).getAllByRole('option');

    expect(select).toBeTruthy();
    expect(options).toHaveLength(2);
    expect(screen.getByRole('option', { name: /settings.basic.editorFont.followOption/i })).toBeTruthy();
    expect(screen.getByRole('option', { name: /settings.basic.editorFont.customOption/i })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: /settings.basic.codeFont.label/i })).toBeTruthy();
    expect(screen.getByDisplayValue('/tmp/MapleMono.ttf')).toBeTruthy();
    expect(screen.getByText(/font unavailable/i)).toBeTruthy();
  });

  it('notifies selection changes immediately for custom font mode', () => {
    const onUiFontSelectionChange = vi.fn();

    render(
      <AppearanceTab
        {...({
          theme: 'dark',
          onThemeChange: vi.fn(),
          fontSizeLevel: 3,
          onFontSizeLevelChange: vi.fn(),
          editorFontConfig: {
            fontFamily: 'Monaco',
            fontSize: 14,
            lineSpacing: 1.35,
          },
          uiFontConfig: {
            mode: 'followEditor',
            effectiveMode: 'followEditor',
            customFontPath: '/tmp/MapleMono.ttf',
            fontFamily: 'Monaco',
            fontSize: 14,
            lineSpacing: 1.35,
          },
          codeFontConfig: {
            mode: 'followEditor',
            effectiveMode: 'followEditor',
            fontFamily: 'Monaco',
            fontSize: 14,
            lineSpacing: 1.35,
          },
          onUiFontSelectionChange,
          onUiFontCustomPathChange: vi.fn(),
          onSaveUiFontCustomPath: vi.fn(),
          onBrowseUiFontFile: vi.fn(),
          onCodeFontSelectionChange: vi.fn(),
          onSaveCodeFontCustomPath: vi.fn(),
          onBrowseCodeFontFile: vi.fn(),
        } as any)}
      />
    );

    fireEvent.change(screen.getByRole('combobox', { name: /settings.basic.editorFont.label/i }), {
      target: { value: 'customFile' },
    });

    expect(onUiFontSelectionChange).toHaveBeenCalledTimes(1);
    expect(onUiFontSelectionChange).toHaveBeenCalledWith('customFile');
  });

  it('applies a shared chat bar preset immediately', () => {
    const onChatBarColorChange = vi.fn();
    renderAppearanceTab({ onChatBarColorChange });

    fireEvent.click(screen.getByRole('button', { name: 'Midnight Blue' }));

    expect(onChatBarColorChange).toHaveBeenCalledWith('#1e3a5f');
  });

  it('accepts only complete hex values for the shared chat bar color', () => {
    const onChatBarColorChange = vi.fn();
    renderAppearanceTab({ onChatBarColorChange });
    const label = screen.getByText('settings.basic.chatBarColor.label');
    const section = label.closest('div[class]')?.parentElement;
    expect(section).toBeTruthy();
    const input = within(section as HTMLElement).getByPlaceholderText('#000000');

    fireEvent.change(input, { target: { value: '#123' } });
    expect(onChatBarColorChange).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: '#123456' } });
    expect(onChatBarColorChange).toHaveBeenCalledWith('#123456');
  });

  it('resets the shared chat bar color to theme defaults', () => {
    const onChatBarColorChange = vi.fn();
    renderAppearanceTab({ chatBarColor: '#1e3a5f', onChatBarColorChange });
    const label = screen.getByText('settings.basic.chatBarColor.label');
    const section = label.closest('div[class]')?.parentElement;
    expect(section).toBeTruthy();

    fireEvent.click(within(section as HTMLElement).getByRole('button', {
      name: 'settings.basic.chatBarColor.reset',
    }));

    expect(onChatBarColorChange).toHaveBeenCalledWith('');
  });
});
