import { render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NodeProcessSelect } from './NodeProcessSelect';

const nodeProcessMocks = vi.hoisted(() => ({
  fetchNodeProcesses: vi.fn(),
  killAllOrphanProcesses: vi.fn(),
  killNodeProcess: vi.fn(),
  restartNodeDaemon: vi.fn(),
  subscribeNodeProcessKillResult: vi.fn(() => vi.fn()),
  subscribeNodeProcesses: vi.fn(() => vi.fn()),
}));

vi.mock('../../../utils/nodeProcessCapabilities', () => ({
  ...nodeProcessMocks,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: string | { defaultValue?: string }) => {
      if (typeof options === 'object' && options?.defaultValue) return options.defaultValue;
      return typeof options === 'string' ? options : key;
    },
  }),
}));

function makeRect(left: number, right: number, width: number): DOMRect {
  return {
    x: left,
    y: 0,
    left,
    right,
    top: 0,
    bottom: 100,
    width,
    height: 100,
    toJSON: () => ({}),
  } as DOMRect;
}

describe('NodeProcessSelect', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 700 });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function getBoundingClientRect(this: HTMLElement) {
      if (this.classList.contains('node-process-dropdown')) {
        const isFlipped = this.style.right === '100%';
        return isFlipped ? makeRect(230, 530, 300) : makeRect(590, 890, 300);
      }
      if (this.dataset.testid === 'node-process-anchor') {
        return makeRect(500, 620, 120);
      }
      return makeRect(0, 0, 0);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps an embedded dropdown flipped without repeatedly toggling layout state', async () => {
    const { container } = render(
      <div data-testid="node-process-anchor">
        <NodeProcessSelect embedded />
      </div>,
    );

    const dropdown = container.querySelector('.node-process-dropdown') as HTMLElement;

    await waitFor(() => {
      expect(dropdown.style.right).toBe('100%');
    });
    expect(dropdown.style.left).toBe('auto');
  });
});
