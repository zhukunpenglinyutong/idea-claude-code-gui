// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ConfigSelect } from './ConfigSelect';

/**
 * The auto-resume-on-limit preference is opt-in and rarely toggled, so it lives
 * in the config menu beside the input box next to its peers (streaming,
 * thinking) rather than in the chat header, which is reserved for
 * high-frequency actions. These tests pin that placement and the Claude-only
 * gating.
 */

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: string | Record<string, unknown>) => {
      const defaultValue = options && typeof options === 'object' && 'defaultValue' in options
        ? String((options as Record<string, unknown>).defaultValue)
        : '';
      return defaultValue || key;
    },
  }),
}));

vi.mock('../../../utils/nodeProcessCapabilities', () => ({
  fetchNodeProcesses: vi.fn(),
  subscribeNodeProcesses: vi.fn(() => () => {}),
}));

vi.mock('../providers/agentProvider', () => ({
  agentProvider: vi.fn(async () => []),
  CREATE_NEW_AGENT_ID: '__create__',
  EMPTY_STATE_ID: '__empty__',
}));

const openMenu = () => {
  // The gear button is the only button before the menu opens.
  fireEvent.click(screen.getAllByRole('button')[0]);
};

describe('ConfigSelect auto-resume row', () => {
  it('renders the auto-resume switch in the config menu when the handler is provided', () => {
    render(<ConfigSelect currentProvider="claude" onToggleAutoResume={vi.fn()} autoResumeEnabled={false} />);
    openMenu();

    const row = screen.getByTestId('config-option-auto-resume');
    expect(row).toBeTruthy();
    expect(row.querySelector('.ant-switch')).toBeTruthy();
    expect(row.textContent).toContain('Auto-resume after usage limit reset');
  });

  it('is hidden when no handler is supplied (non-Claude providers)', () => {
    render(<ConfigSelect currentProvider="codex" />);
    openMenu();

    expect(screen.queryByTestId('config-option-auto-resume')).toBeNull();
    // Sanity: the menu did open — its peer preference rows are present.
    expect(screen.getByTestId('config-option-agent')).toBeTruthy();
  });

  it('requests the inverted state when the row is clicked', () => {
    const onToggleAutoResume = vi.fn();
    render(<ConfigSelect currentProvider="claude" onToggleAutoResume={onToggleAutoResume} autoResumeEnabled={false} />);
    openMenu();

    fireEvent.click(screen.getByTestId('config-option-auto-resume'));
    expect(onToggleAutoResume).toHaveBeenCalledWith(true);
  });

  it('turns the preference back off from an enabled state', () => {
    const onToggleAutoResume = vi.fn();
    render(<ConfigSelect currentProvider="claude" onToggleAutoResume={onToggleAutoResume} autoResumeEnabled />);
    openMenu();

    fireEvent.click(screen.getByTestId('config-option-auto-resume'));
    expect(onToggleAutoResume).toHaveBeenCalledWith(false);
  });
});
