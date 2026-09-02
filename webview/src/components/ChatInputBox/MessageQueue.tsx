import { useState } from 'react';
import { ArrowDownToLine, ArrowUpToLine } from 'lucide-react';
import type { QueuedMessage } from '../../hooks/useMessageQueue';
import { MESSAGE_QUEUE_FEATURES } from '../../constants/messageQueueFeatures';

export interface MessageQueueProps {
  /** Queue items */
  queue: QueuedMessage[];
  /** Remove item callback */
  onRemove: (id: string) => void;
  /** Update item content callback */
  onUpdate?: (id: string, content: string) => void;
  /** Move item one position earlier callback */
  onMoveUp?: (id: string) => void;
  /** Move item one position later callback */
  onMoveDown?: (id: string) => void;
  /** Move item to the next execution position callback */
  onMoveToFront?: (id: string) => void;
  /** Move item to the last execution position callback */
  onMoveToBack?: (id: string) => void;
  /** Insert item into the next execution position callback */
  onInsert?: (id: string) => void;
  /** Interrupt the current task and prioritize an item callback */
  onInterrupt?: (id: string) => void;
}

/**
 * MessageQueue - Displays queued messages above input box
 * Shows numbered list with message preview and close button
 */
export function MessageQueue({
  queue,
  onRemove,
  onUpdate,
  onMoveUp,
  onMoveDown,
  onMoveToFront,
  onMoveToBack,
  onInsert,
  onInterrupt,
}: MessageQueueProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  if (queue.length === 0) {
    return null;
  }

  const startEditing = (item: QueuedMessage) => {
    setEditingId(item.id);
    setDraft(item.content);
  };

  const cancelEditing = () => {
    setEditingId(null);
    setDraft('');
  };

  const saveEditing = () => {
    if (!editingId || !draft.trim()) return;

    onUpdate?.(editingId, draft.trim());
    cancelEditing();
  };

  const removeItem = (id: string) => {
    onRemove(id);
    if (editingId === id) {
      cancelEditing();
    }
  };

  return (
    <div className="message-queue">
      {/* Render in reverse order so newest is at bottom (closest to input) */}
      {[...queue].reverse().map((item, reversedIndex) => {
        // Calculate actual queue position (1-based, from bottom)
        const queuePosition = queue.length - reversedIndex;
        const itemIndex = queuePosition - 1;
        const isEditing = editingId === item.id;
        return (
          <div key={item.id} className={`message-queue-item${isEditing ? ' is-editing' : ''}`}>
            <span className="message-queue-number">{queuePosition}</span>
            {MESSAGE_QUEUE_FEATURES.reorder && (
              <div className="message-queue-order-actions">
                <button
                  type="button"
                  className="message-queue-icon-button"
                  onClick={(event) => {
                    event.stopPropagation();
                    // 队列倒序展示：视觉上移等于逻辑上延后执行。
                    onMoveDown?.(item.id);
                  }}
                  title="上移一位（更晚执行）"
                  aria-label="上移一位（更晚执行）"
                  disabled={itemIndex === queue.length - 1}
                >
                  <span className="codicon codicon-arrow-up" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="message-queue-icon-button"
                  onClick={(event) => {
                    event.stopPropagation();
                    // 队列倒序展示：视觉下移等于逻辑上提前执行。
                    onMoveUp?.(item.id);
                  }}
                  title="下移一位（更早执行）"
                  aria-label="下移一位（更早执行）"
                  disabled={itemIndex === 0}
                >
                  <span className="codicon codicon-arrow-down" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="message-queue-icon-button"
                  onClick={(event) => {
                    event.stopPropagation();
                    onMoveToFront?.(item.id);
                  }}
                  title="移动到队首（下一条执行）"
                  aria-label="移动到队首（下一条执行）"
                  disabled={itemIndex === 0}
                >
                  <ArrowDownToLine size={14} strokeWidth={2} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="message-queue-icon-button"
                  onClick={(event) => {
                    event.stopPropagation();
                    onMoveToBack?.(item.id);
                  }}
                  title="移动到队尾（最后执行）"
                  aria-label="移动到队尾（最后执行）"
                  disabled={itemIndex === queue.length - 1}
                >
                  <ArrowUpToLine size={14} strokeWidth={2} aria-hidden="true" />
                </button>
              </div>
            )}
            {isEditing ? (
              <textarea
                className="message-queue-editor"
                value={draft}
                onClick={(event) => event.stopPropagation()}
                onChange={(event) => setDraft(event.target.value)}
                aria-label="编辑队列消息"
              />
            ) : (
              <span className="message-queue-content" title={item.content}>
                {item.content}
              </span>
            )}
            <div className="message-queue-item-actions">
              {isEditing ? (
                <>
                  <button
                    type="button"
                    className="message-queue-icon-button"
                    onClick={(event) => {
                      event.stopPropagation();
                      saveEditing();
                    }}
                    title="保存修改"
                    aria-label="保存修改"
                    disabled={!draft.trim()}
                  >
                    <span className="codicon codicon-check" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="message-queue-icon-button"
                    onClick={(event) => {
                      event.stopPropagation();
                      cancelEditing();
                    }}
                    title="取消编辑"
                    aria-label="取消编辑"
                  >
                    <span className="codicon codicon-close" aria-hidden="true" />
                  </button>
                </>
              ) : (
                <>
                  {MESSAGE_QUEUE_FEATURES.edit && (
                    <button
                      type="button"
                      className="message-queue-icon-button"
                      onClick={(event) => {
                        event.stopPropagation();
                        startEditing(item);
                      }}
                      title="编辑本条消息"
                      aria-label="编辑本条消息"
                    >
                      <span className="codicon codicon-edit" aria-hidden="true" />
                    </button>
                  )}
                  {MESSAGE_QUEUE_FEATURES.insert && (
                    <button
                      type="button"
                      className="message-queue-icon-button message-queue-insert"
                      onClick={(event) => {
                        event.stopPropagation();
                        onInsert?.(item.id);
                      }}
                      title="插入到下一次执行"
                      aria-label="插入到下一次执行"
                    >
                      <span className="codicon codicon-play" aria-hidden="true" />
                    </button>
                  )}
                  {MESSAGE_QUEUE_FEATURES.interrupt && (
                    <button
                      type="button"
                      className="message-queue-icon-button message-queue-interrupt"
                      onClick={(event) => {
                        event.stopPropagation();
                        onInterrupt?.(item.id);
                      }}
                      title="打断当前任务并优先执行本条"
                      aria-label="打断当前任务并优先执行本条"
                    >
                      <span className="codicon codicon-stop" aria-hidden="true" />
                    </button>
                  )}
                  <button
                    type="button"
                    className="message-queue-icon-button message-queue-remove"
                    onClick={(event) => {
                      event.stopPropagation();
                      removeItem(item.id);
                    }}
                    title="从队列移除"
                    aria-label="从队列移除"
                  >
                    <span className="codicon codicon-close" aria-hidden="true" />
                  </button>
                </>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default MessageQueue;
