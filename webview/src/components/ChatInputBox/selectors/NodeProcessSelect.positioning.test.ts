import { describe, expect, it } from 'vitest';
import { getEmbeddedNodeProcessDropdownLayout } from './NodeProcessSelect';

describe('NodeProcessSelect dropdown positioning', () => {
  it('keeps the submenu flipped left after right-side overflow is detected', () => {
    const layout = getEmbeddedNodeProcessDropdownLayout({
      parentRect: { left: 190, right: 390, top: 0 },
      viewportWidth: 410,
      viewportHeight: 700,
      dropdownHeight: 350,
    });

    expect(layout.flipToLeft).toBe(true);
  });

  it('keeps the submenu on the right when there is enough room', () => {
    const layout = getEmbeddedNodeProcessDropdownLayout({
      parentRect: { left: 40, right: 240, top: 0 },
      viewportWidth: 700,
      viewportHeight: 700,
      dropdownHeight: 260,
    });

    expect(layout.flipToLeft).toBe(false);
  });

  it('clamps width and height to the visible viewport', () => {
    const layout = getEmbeddedNodeProcessDropdownLayout({
      parentRect: { left: 20, right: 180, top: 120 },
      viewportWidth: 260,
      viewportHeight: 240,
      dropdownHeight: 500,
    });

    expect(layout.maxWidth).toBeLessThanOrEqual(360);
    expect(layout.maxWidth).toBeGreaterThan(0);
    expect(layout.maxHeight).toBeLessThanOrEqual(240 - 8 - 120 - layout.topOffset);
    expect(layout.maxHeight).toBeGreaterThan(0);
  });
});
