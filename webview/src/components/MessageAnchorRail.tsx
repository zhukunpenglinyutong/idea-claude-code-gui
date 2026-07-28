import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ClaudeMessage } from '../types';
import { getMessageKey } from '../utils/messageUtils';

interface AnchorItem {
  id: string;
  position: number;
  preview: string;
}

interface MessageAnchorRailProps {
  messages: ClaudeMessage[];
  /** Number of messages hidden by the collapse feature. Anchors start after this offset. */
  collapsedCount?: number;
  containerRef: React.RefObject<HTMLDivElement | null>;
  messageNodeMap: React.RefObject<Map<string, HTMLDivElement>>;
}

const MAX_PREVIEW_LENGTH = 300;
const MAX_ANCHOR_COUNT = 30;
const TOOLTIP_DELAY_MS = 500;

export function sampleAnchorItems(items: AnchorItem[], maxCount = MAX_ANCHOR_COUNT): AnchorItem[] {
  if (items.length <= maxCount || maxCount < 2) {
    return items;
  }
  return Array.from({ length: maxCount }, (_, index) => {
    const sourceIndex = Math.round((index / (maxCount - 1)) * (items.length - 1));
    return items[sourceIndex];
  });
}

function getAnchorStyle(position: number): React.CSSProperties {
  return { top: `${position * 100}%` };
}

/**
 * Extracts a short preview text from a user message for the tooltip.
 * Strips control characters and collapses excessive whitespace for clean display.
 */
function getMessagePreview(message: ClaudeMessage): string {
  const raw = message.content?.trim() ?? '';
  if (!raw) return '';
  // Strip control characters (except common whitespace) and collapse runs of whitespace
  const text = raw
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  if (text.length <= MAX_PREVIEW_LENGTH) return text;
  return text.slice(0, MAX_PREVIEW_LENGTH) + '...';
}

export const MessageAnchorRail = memo(function MessageAnchorRail({
  messages,
  collapsedCount = 0,
  containerRef,
  messageNodeMap,
}: MessageAnchorRailProps) {
  const [activeAnchorId, setActiveAnchorId] = useState<string | null>(null);
  const [tooltipAnchorId, setTooltipAnchorId] = useState<string | null>(null);
  const tooltipTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTooltipTimer = useCallback(() => {
    if (tooltipTimerRef.current !== null) {
      clearTimeout(tooltipTimerRef.current);
      tooltipTimerRef.current = null;
    }
  }, []);

  const handleDotMouseEnter = useCallback((anchorId: string) => {
    clearTooltipTimer();
    tooltipTimerRef.current = setTimeout(() => {
      setTooltipAnchorId(anchorId);
    }, TOOLTIP_DELAY_MS);
  }, [clearTooltipTimer]);

  const handleDotMouseLeave = useCallback(() => {
    clearTooltipTimer();
    setTooltipAnchorId(null);
  }, [clearTooltipTimer]);

  // Cleanup timer on unmount
  useEffect(() => clearTooltipTimer, [clearTooltipTimer]);

  // Compute anchor items from visible user messages only (skip collapsed ones)
  const anchors = useMemo<AnchorItem[]>(() => {
    const userMessages: AnchorItem[] = [];
    const startIndex = collapsedCount;
    for (let i = startIndex; i < messages.length; i++) {
      if (messages[i].type === 'user') {
        userMessages.push({
          id: getMessageKey(messages[i], i),
          position: 0,
          preview: getMessagePreview(messages[i]),
        });
      }
    }
    // Guard: also prevents division by zero in the position calculation below
    if (userMessages.length <= 1) return [];
    // Keep the rail usable for long conversations by sampling evenly across the
    // full message range while retaining the first and last user messages.
    const visibleMessages = sampleAnchorItems(userMessages);
    return visibleMessages.map((item, idx) => ({
      ...item,
      position: 0.04 + (idx / (visibleMessages.length - 1)) * 0.92,
    }));
  }, [messages, collapsedCount]);

  // Scroll to a specific anchor message
  const scrollToAnchor = useCallback((messageId: string) => {
    const node = messageNodeMap.current?.get(messageId);
    const container = containerRef.current;
    if (!node || !container) return;

    const containerRect = container.getBoundingClientRect();
    const nodeRect = node.getBoundingClientRect();
    const targetTop =
      container.scrollTop + (nodeRect.top - containerRect.top) - container.clientHeight * 0.28;

    container.scrollTo({
      top: Math.max(0, targetTop),
      behavior: 'smooth',
    });
    setActiveAnchorId(messageId);
  }, [containerRef, messageNodeMap]);

  // Use IntersectionObserver to track which anchor message is visible.
  // This replaces the old scroll-handler + getBoundingClientRect() loop
  // which caused layout thrashing (N forced layout reads per scroll frame).
  useEffect(() => {
    const container = containerRef.current;
    const nodeMap = messageNodeMap.current;
    if (!container || !nodeMap || anchors.length === 0) return;

    // Track which anchor IDs are currently intersecting the viewport
    const visibleSet = new Set<string>();

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = (entry.target as HTMLElement).dataset.messageAnchorId;
          if (!id) continue;
          if (entry.isIntersecting) {
            visibleSet.add(id);
          } else {
            visibleSet.delete(id);
          }
        }

        // Pick the first visible anchor (topmost in DOM order)
        // by iterating anchors in order and checking membership
        for (const anchor of anchors) {
          if (visibleSet.has(anchor.id)) {
            setActiveAnchorId((prev) => (prev === anchor.id ? prev : anchor.id));
            return;
          }
        }
      },
      {
        root: container,
        // Trigger when a message enters the top ~32% of the viewport
        rootMargin: '0px 0px -68% 0px',
        threshold: 0,
      }
    );

    // Observe all user-message nodes that have anchors
    const anchorIds = new Set(anchors.map((a) => a.id));
    for (const [id, node] of nodeMap) {
      if (anchorIds.has(id)) {
        observer.observe(node);
      }
    }

    return () => {
      observer.disconnect();
    };
  }, [containerRef, messageNodeMap, anchors]);

  if (anchors.length === 0) return null;

  return (
    <div className="messages-anchor-rail" role="navigation" aria-label="Message anchors">
      <div className="messages-anchor-track" aria-hidden="true" />
      {anchors.map((anchor, index) => {
        const isActive = activeAnchorId === anchor.id;
        const showTooltip = tooltipAnchorId === anchor.id && anchor.preview;
        return (
          <div
            key={anchor.id}
            role="button"
            tabIndex={0}
            className={`messages-anchor-dot${isActive ? ' is-active' : ''}`}
            style={getAnchorStyle(anchor.position)}
            onClick={() => scrollToAnchor(anchor.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                scrollToAnchor(anchor.id);
              }
            }}
            onMouseEnter={() => handleDotMouseEnter(anchor.id)}
            onMouseLeave={handleDotMouseLeave}
            aria-label={`Go to user message ${index + 1}`}
          >
            {showTooltip && (
              <div className="anchor-tooltip">{anchor.preview}</div>
            )}
          </div>
        );
      })}
    </div>
  );
});
