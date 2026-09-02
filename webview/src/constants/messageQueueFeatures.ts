/**
 * 消息队列增强功能开关。
 *
 * 第一阶段已完成编辑、按钮式排序和插入；拖放与打断将在后续阶段启用。
 */
export const MESSAGE_QUEUE_FEATURES = {
  edit: true,
  reorder: true,
  insert: true,
  dragReorder: false,
  interrupt: true,
} as const;
