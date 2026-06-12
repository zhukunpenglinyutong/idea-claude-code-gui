import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { DropdownItemProps } from '../types';

const SVG_ICON_STYLE: React.CSSProperties = {
  width: 16,
  height: 16,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
};

const DISABLED_ITEM_STYLE: React.CSSProperties = { cursor: 'default' };

/**
 * DropdownItem - Dropdown menu item component
 */
export const DropdownItem = ({
  item,
  isActive = false,
  onClick,
  onMouseEnter,
}: DropdownItemProps) => {
  const itemRef = useRef<HTMLDivElement>(null);
  const [showTooltip, setShowTooltip] = useState(false);
  const [tooltipPosition, setTooltipPosition] = useState<{ top: number; left: number; placement: 'top' | 'bottom' }>({
    top: 0,
    left: 0,
    placement: 'bottom'
  });

  /**
   * Handle mouse enter to show tooltip
   */
  const handleMouseEnterItem = () => {
    if (!itemRef.current || !item.description) return;

    const rect = itemRef.current.getBoundingClientRect();
    const viewportHeight = window.innerHeight;
    const spaceBelow = viewportHeight - rect.bottom;
    const tooltipEstimatedHeight = 100;

    // Determine tooltip placement
    const placement = spaceBelow < tooltipEstimatedHeight ? 'top' : 'bottom';

    setTooltipPosition({
      top: placement === 'bottom' ? rect.bottom + 8 : rect.top - 8,
      left: rect.left + rect.width / 2,
      placement
    });
    setShowTooltip(true);
  };

  /**
   * Handle mouse leave to hide tooltip
   */
  const handleMouseLeaveItem = () => {
    setShowTooltip(false);
  };

  /**
   * Render icon
   */
  const renderIcon = () => {
    const icon = typeof item.icon === 'string' ? item.icon.trim() : '';
    const isInlineSvgIcon = icon.startsWith('<svg');

    // If icon contains SVG tags, it's an inline SVG
    if (isInlineSvgIcon) {
      return (
        <span
          className="dropdown-item-icon"
          dangerouslySetInnerHTML={{ __html: icon }}
          style={SVG_ICON_STYLE}
        />
      );
    }

    // Otherwise use codicon class name
    const iconClass = icon || getDefaultIconClass(item.type);
    return <span className={`dropdown-item-icon codicon ${iconClass}`} />;
  };

  /**
   * Get default icon class name (for codicon)
   */
  const getDefaultIconClass = (type?: string): string => {
    switch (type) {
      case 'file':
        return 'codicon-file';
      case 'directory':
        return 'codicon-folder';
      case 'command':
        return 'codicon-terminal';
      default:
        return 'codicon-symbol-misc';
    }
  };

  /**
   * Render portal tooltip
   */
  const renderTooltip = () => {
    if (!showTooltip || !item.description) return null;

    const viewportHeight = window.innerHeight;

    const tooltipStyle: React.CSSProperties = {
      position: 'fixed',
      left: tooltipPosition.left,
      transform: 'translateX(-50%)',
      ...(tooltipPosition.placement === 'bottom'
        ? { top: tooltipPosition.top }
        : { bottom: viewportHeight - tooltipPosition.top, transform: 'translateX(-50%)' }
      ),
      zIndex: 9999,
      maxWidth: '400px',
      minWidth: '200px',
      width: 'max-content',
      background: 'var(--dropdown-bg)',
      color: 'var(--text-primary)',
      border: '1px solid var(--dropdown-border)',
      borderRadius: '6px',
      padding: '8px 12px',
      fontSize: '12px',
      lineHeight: '1.4',
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word',
      boxShadow: '0 4px 12px rgba(0, 0, 0, 0.25)',
      pointerEvents: 'none',
      animation: 'tooltip-fade-in 0.2s forwards'
    };

    const arrowStyle: React.CSSProperties = {
      position: 'fixed',
      left: tooltipPosition.left,
      transform: 'translateX(-50%)',
      ...(tooltipPosition.placement === 'bottom'
        ? {
            top: tooltipPosition.top - 6,
            borderLeft: '6px solid transparent',
            borderRight: '6px solid transparent',
            borderBottom: '6px solid var(--dropdown-border)'
          }
        : {
            bottom: viewportHeight - tooltipPosition.top - 6,
            borderLeft: '6px solid transparent',
            borderRight: '6px solid transparent',
            borderTop: '6px solid var(--dropdown-border)'
          }
      ),
      width: 0,
      height: 0,
      zIndex: 9999,
      pointerEvents: 'none'
    };

    return createPortal(
      <>
        <div style={arrowStyle} />
        <div style={tooltipStyle}>
          {item.description}
        </div>
      </>,
      document.body
    );
  };

  // Separator
  if (item.type === 'separator') {
    return <div className="dropdown-separator" />;
  }

  // Section header
  if (item.type === 'section-header') {
    return (
      <div className="dropdown-section-header">
        {item.label}
      </div>
    );
  }

  // All items are selectable (except loading indicator items)
  const isDisabled = item.id === '__loading__';

  return (
    <>
      <div
        ref={itemRef}
        className={`dropdown-item ${isActive ? 'active' : ''} ${isDisabled ? 'disabled' : ''}`}
        onClick={isDisabled ? undefined : onClick}
        onMouseEnter={() => {
          // Call the original onMouseEnter (for keyboard navigation highlighting)
          onMouseEnter?.();
          // Show tooltip
          handleMouseEnterItem();
        }}
        onMouseLeave={handleMouseLeaveItem}
        style={isDisabled ? DISABLED_ITEM_STYLE : undefined}
      >
        {renderIcon()}
        <div className="dropdown-item-content">
          <div className="dropdown-item-label">{item.label}</div>
          {item.description && (
            <div className="dropdown-item-description">{item.description}</div>
          )}
        </div>
      </div>
      {renderTooltip()}
    </>
  );
};

export default DropdownItem;
