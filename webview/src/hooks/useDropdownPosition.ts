import { useCallback, useState, type CSSProperties, type RefObject } from 'react';
import { getAppViewport } from '../utils/viewport';

type DropdownAlignment = 'left' | 'right';

interface UseDropdownPositionOptions {
  buttonRef: RefObject<HTMLElement | null>;
  dropdownRef?: RefObject<HTMLElement | null>;
  preferredAlignment?: DropdownAlignment;
  minWidth?: number;
  submenuMaxHeight?: number;
  submenuBottomClearance?: number;
  submenu?: boolean;
}

interface PositionState {
  left?: number;
  top?: number | string;
  bottom?: number;
  maxHeight: number;
  submenuSide?: 'right' | 'left';
  submenuOverlap?: number;
}

const FALLBACK_ABSOLUTE_LEFT: CSSProperties = {
  position: 'absolute',
  bottom: '100%',
  marginBottom: '4px',
  left: 0,
};

const FALLBACK_ABSOLUTE_RIGHT: CSSProperties = {
  position: 'absolute',
  bottom: '100%',
  marginBottom: '4px',
  right: 0,
};

const FALLBACK_SUBMENU_RIGHT: CSSProperties = {
  position: 'absolute',
  top: 0,
  left: '100%',
};

export function useDropdownPosition({
  buttonRef,
  dropdownRef,
  preferredAlignment = 'left',
  minWidth = 200,
  submenuMaxHeight = 300,
  submenuBottomClearance = 96,
  submenu = false,
}: UseDropdownPositionOptions): {
  positionedStyle: CSSProperties;
  maxHeight: number | undefined;
  recalculate: () => void;
} {
  const [positionState, setPositionState] = useState<PositionState | null>(null);

  const recalculate = useCallback(() => {
    const button = buttonRef.current;
    if (!button) return;

    const rect = button.getBoundingClientRect();
    const { width: viewportWidth, height: viewportHeight, left: viewportLeft, top: viewportTop } = getAppViewport();
    const padding = 8;
    const gap = 4;
    const buttonLeft = rect.left - viewportLeft;
    const buttonRight = rect.right - viewportLeft;
    const buttonTop = rect.top - viewportTop;
    const dropdown = dropdownRef?.current;

    if (submenu) {
      const availableRight = Math.max(0, viewportWidth - padding - buttonRight);
      const availableLeft = Math.max(0, buttonLeft - padding);
      const side: 'right' | 'left' = availableRight >= minWidth
        ? 'right'
        : availableLeft >= minWidth
          ? 'left'
          : availableRight >= availableLeft ? 'right' : 'left';
      const availableSideWidth = side === 'right' ? availableRight : availableLeft;
      const submenuOverlap = Math.max(0, minWidth - availableSideWidth);
      const measuredHeight = dropdown
        ? Math.max(dropdown.getBoundingClientRect().height, dropdown.scrollHeight)
        : submenuMaxHeight;
      const desiredHeight = Math.min(submenuMaxHeight, Math.max(1, measuredHeight));
      const availableBelow = viewportHeight - padding - buttonTop;
      const minTopOffset = padding - buttonTop;
      const topOffset = Math.max(
        minTopOffset,
        Math.min(0, availableBelow - desiredHeight - submenuBottomClearance),
      );
      const availableHeight = viewportHeight - padding - buttonTop - topOffset;
      const maxHeight = Math.max(1, Math.min(submenuMaxHeight, availableHeight));

      setPositionState({ top: topOffset, maxHeight, submenuSide: side, submenuOverlap });
      return;
    }

    const dropdownWidth = dropdown
      ? Math.min(
          Math.max(minWidth, dropdown.getBoundingClientRect().width),
          viewportWidth - (padding * 2),
        )
      : minWidth;
    const leftAlignedLeft = buttonLeft;
    const rightAlignedLeft = buttonRight - dropdownWidth;
    let left: number;

    if (preferredAlignment === 'right') {
      left = rightAlignedLeft >= padding ? rightAlignedLeft : leftAlignedLeft;
    } else {
      left = leftAlignedLeft + dropdownWidth + padding <= viewportWidth ? leftAlignedLeft : rightAlignedLeft;
    }
    left = Math.max(padding, Math.min(left, viewportWidth - dropdownWidth - padding));

    const bottomValue = viewportHeight - buttonTop + gap;
    const dropdownMaxHeight = buttonTop - gap - padding;

    setPositionState({ left, bottom: bottomValue, maxHeight: dropdownMaxHeight, submenuSide: 'right' });
  }, [buttonRef, dropdownRef, preferredAlignment, minWidth, submenu, submenuBottomClearance, submenuMaxHeight]);

  if (!positionState) {
    if (submenu) {
      return { positionedStyle: FALLBACK_SUBMENU_RIGHT, maxHeight: undefined, recalculate };
    }
    return {
      positionedStyle: preferredAlignment === 'left' ? FALLBACK_ABSOLUTE_LEFT : FALLBACK_ABSOLUTE_RIGHT,
      maxHeight: undefined,
      recalculate,
    };
  }

  if (submenu) {
    const sideStyle: CSSProperties = positionState.submenuSide === 'left'
      ? { right: '100%', marginRight: `-${positionState.submenuOverlap ?? 0}px` }
      : { left: '100%', marginLeft: `-${positionState.submenuOverlap ?? 0}px` };

    return {
      positionedStyle: {
        position: 'absolute',
        top: positionState.top,
        ...sideStyle,
        zIndex: 10001,
      },
      maxHeight: positionState.maxHeight,
      recalculate,
    };
  }

  const { fixedPosDivisor } = getAppViewport();
  return {
    positionedStyle: {
      position: 'fixed',
      left: (positionState.left ?? 0) / fixedPosDivisor,
      bottom: (positionState.bottom ?? 0) / fixedPosDivisor,
      zIndex: 10000,
    },
    maxHeight: positionState.maxHeight / fixedPosDivisor,
    recalculate,
  };
}
