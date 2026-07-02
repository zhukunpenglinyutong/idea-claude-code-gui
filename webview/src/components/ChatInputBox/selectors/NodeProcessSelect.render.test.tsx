import { render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NodeProcessSelect } from './NodeProcessSelect';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: string | Record<string, string | number>) => {
      if (options && typeof options === 'object' && typeof options.defaultValue === 'string') {
        return options.defaultValue;
      }
      return key;
    },
  }),
}));

vi.mock('../../../utils/nodeProcessCapabilities', () => ({
  fetchNodeProcesses: vi.fn(),
  killAllOrphanProcesses: vi.fn(),
  killNodeProcess: vi.fn(),
  restartNodeDaemon: vi.fn(),
  subscribeNodeProcesses: vi.fn(() => () => undefined),
  subscribeNodeProcessKillResult: vi.fn(() => () => undefined),
}));

vi.mock('../../../utils/viewport', () => ({
  getAppViewport: () => ({ left: 0, top: 0, width: 410, height: 700 }),
}));

function rect(left: number, right: number, width = right - left, top = 0, height = 200): DOMRect {
  return {
    x: left,
    y: top,
    left,
    right,
    top,
    bottom: top + height,
    width,
    height,
    toJSON: () => ({}),
  } as DOMRect;
}

describe('NodeProcessSelect render positioning', () => {
  let getBoundingClientRectSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    getBoundingClientRectSpy = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function getMockRect(this: HTMLElement) {
        if (this.classList.contains('node-process-dropdown')) {
          return this.style.right === '100%'
            ? rect(10, 360, 350)
            : rect(390, 740, 350);
        }
        if (this.dataset.testid === 'node-process-anchor') {
          return rect(190, 390, 200);
        }
        return rect(0, 0, 0);
      });
  });

  afterEach(() => {
    getBoundingClientRectSpy.mockRestore();
  });

  it('does not enter a layout update loop when the flipped dropdown has different measured bounds', async () => {
    const { container } = render(
      <div data-testid="node-process-anchor">
        <NodeProcessSelect embedded />
      </div>,
    );

    const dropdown = container.querySelector<HTMLElement>('.node-process-dropdown');
    expect(dropdown).not.toBeNull();

    await waitFor(() => {
      expect(dropdown?.style.right).toBe('100%');
    });
  });
});
