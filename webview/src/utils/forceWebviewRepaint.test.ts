import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { forceWebviewRepaint } from './forceWebviewRepaint';

describe('forceWebviewRepaint', () => {
  let rafQueue: FrameRequestCallback[] = [];
  let fontScale = '1.1';

  beforeEach(() => {
    vi.useFakeTimers();
    rafQueue = [];
    fontScale = '1.1';
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      rafQueue.push(cb);
      return rafQueue.length;
    });
    vi.stubGlobal('getComputedStyle', () => ({
      getPropertyValue: () => fontScale,
    }) as unknown as CSSStyleDeclaration);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** Drain the queued rAF callbacks (the util uses a double rAF). */
  const flushRaf = () => {
    while (rafQueue.length > 0) {
      const cb = rafQueue.shift()!;
      cb(0);
    }
  };

  it('toggles inline zoom and dispatches resize after a double rAF', () => {
    const zoomWrites: string[] = [];
    const app = {
      style: {
        set zoom(v: string) { zoomWrites.push(v); },
        get zoom() { return zoomWrites[zoomWrites.length - 1] ?? ''; },
      },
      offsetHeight: 0,
    } as unknown as HTMLElement;

    vi.spyOn(document, 'getElementById').mockReturnValue(app);
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent').mockReturnValue(true);

    forceWebviewRepaint('unit-test');

    // The nudge is deferred until React finishes its unmount/reflow (double rAF).
    expect(zoomWrites).toHaveLength(0);
    expect(dispatchSpy).not.toHaveBeenCalled();

    flushRaf();

    // zoom is forced to '1' then restored to the --font-scale value, forcing
    // Chromium/JCEF to re-rasterize the whole viewport.
    expect(zoomWrites).toEqual(['1', '1.1']);
    const resizeDispatched = dispatchSpy.mock.calls.some(
      ([evt]) => evt instanceof Event && evt.type === 'resize'
    );
    expect(resizeDispatched).toBe(true);
  });

  it('is a no-op and does not throw when #app is missing', () => {
    vi.spyOn(document, 'getElementById').mockReturnValue(null);
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');

    expect(() => {
      forceWebviewRepaint();
      flushRaf();
    }).not.toThrow();
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it('uses a timer fallback when JCEF does not deliver animation frames', () => {
    const zoomWrites: string[] = [];
    const app = {
      style: {
        set zoom(v: string) { zoomWrites.push(v); },
        get zoom() { return zoomWrites[zoomWrites.length - 1] ?? ''; },
      },
      offsetHeight: 0,
    } as unknown as HTMLElement;

    vi.spyOn(document, 'getElementById').mockReturnValue(app);
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent').mockReturnValue(true);

    forceWebviewRepaint('tab-activated');
    vi.advanceTimersByTime(50);

    expect(zoomWrites).toEqual(['1', '1.1']);
    expect(dispatchSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'resize' }));
  });

  it('uses a distinct zoom nudge for repeated repaints at 100 percent scale', () => {
    fontScale = '1';
    const zoomWrites: string[] = [];
    const app = {
      style: {
        set zoom(v: string) { zoomWrites.push(v); },
        get zoom() { return zoomWrites[zoomWrites.length - 1] ?? '1'; },
      },
      offsetHeight: 0,
    } as unknown as HTMLElement;

    vi.spyOn(document, 'getElementById').mockReturnValue(app);

    forceWebviewRepaint('first-activation');
    flushRaf();
    forceWebviewRepaint('second-activation');
    flushRaf();

    expect(zoomWrites).toEqual(['0.999', '1', '0.999', '1']);
  });
});
