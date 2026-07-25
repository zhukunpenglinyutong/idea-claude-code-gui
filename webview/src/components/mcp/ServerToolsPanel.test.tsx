import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ServerToolsPanel } from './ServerToolsPanel';

const baseProps = {
  isConnected: true,
  isCodexMode: false,
  t: (key: string) => key,
  onLoadTools: vi.fn(),
  onToolHover: vi.fn(),
};

describe('ServerToolsPanel empty tool state', () => {
  it('does not show no-tools while loading or after an error', () => {
    const view = render(<ServerToolsPanel
      {...baseProps}
      toolsInfo={{ tools: [], loading: true }}
    />);

    expect(view.queryByText('mcp.noTools')).toBeNull();

    view.rerender(<ServerToolsPanel
      {...baseProps}
      toolsInfo={{ tools: [], loading: false, error: 'tools/list failed' }}
    />);

    expect(view.queryByText('mcp.noTools')).toBeNull();
    expect(view.getByText('mcp.loadFailed')).toBeTruthy();
  });

  it('shows a warning after a connected server finishes with no tools', () => {
    const view = render(<ServerToolsPanel
      {...baseProps}
      toolsInfo={{ tools: [], loading: false }}
    />);

    const emptyState = view.getByText('mcp.noTools');
    expect(emptyState.style.color).toBe('var(--color-warning)');
  });

  it('hides stale empty-tool results after the server disconnects', () => {
    const view = render(<ServerToolsPanel
      {...baseProps}
      isConnected={false}
      toolsInfo={{ tools: [], loading: false }}
    />);

    expect(view.queryByText('mcp.noTools')).toBeNull();
    expect(view.getByText('mcp.notConnected')).toBeTruthy();
  });
});
