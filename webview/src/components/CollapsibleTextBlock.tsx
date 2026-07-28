import React, { useState, useRef, useEffect } from 'react';

interface CollapsibleTextBlockProps {
  content: string;
}

const MAX_HEIGHT = 160; // Approx 7-8 lines

// Very large pasted texts (hundreds of KB) must not be fully materialized in the
// DOM while collapsed: the node is laid out (and re-measured by the
// ResizeObserver) even though max-height hides it visually. Above the
// threshold only a preview slice is rendered until the user expands.
const LARGE_CONTENT_THRESHOLD = 20000;
const COLLAPSED_PREVIEW_CHARS = 10000;

const CollapsibleTextBlock: React.FC<CollapsibleTextBlockProps> = ({ content }) => {
  const [expanded, setExpanded] = useState(false);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  const isLargeContent = content.length > LARGE_CONTENT_THRESHOLD;
  const displayContent = !expanded && isLargeContent
    ? content.slice(0, COLLAPSED_PREVIEW_CHARS)
    : content;
  // Large content always overflows the collapsed height — force the affordance on
  const showOverflow = isOverflowing || isLargeContent;

  useEffect(() => {
    if (!contentRef.current) return;

    const checkHeight = () => {
      if (contentRef.current) {
        setIsOverflowing(contentRef.current.scrollHeight > MAX_HEIGHT);
      }
    };

    // Check initially
    checkHeight();

    // Use ResizeObserver to detect size changes (e.g. window resize or content loading)
    const observer = new ResizeObserver(checkHeight);
    observer.observe(contentRef.current);

    return () => observer.disconnect();
  }, [displayContent]);

  const toggleExpand = (e: React.MouseEvent) => {
    e.stopPropagation();
    setExpanded(!expanded);
  };

  const contentStyle: React.CSSProperties = {
    maxHeight: (expanded || !showOverflow) ? 'none' : `${MAX_HEIGHT}px`,
    overflow: 'hidden',
  };
  const chevronStyle: React.CSSProperties = {
    transform: expanded ? 'rotate(180deg)' : 'none',
    transition: 'transform 0.2s',
  };

  return (
    <div className={`collapsible-block ${expanded ? 'expanded' : 'collapsed'}`}>
      <div
        className="collapsible-content"
        ref={contentRef}
        style={contentStyle}
      >
        <div className="plain-text-content">{displayContent}</div>

        {/* Gradient overlay when collapsed */}
        {!expanded && showOverflow && (
             <div className="collapse-overlay"></div>
        )}
      </div>

      {showOverflow && (
        <div className="collapse-toggle" onClick={toggleExpand}>
            <span className="codicon codicon-chevron-down" style={chevronStyle}></span>
        </div>
      )}
    </div>
  );
};

export default CollapsibleTextBlock;
