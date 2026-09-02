export const MESSAGE_QUEUE_STREAM_STARTED_EVENT = 'message-queue-stream-started';
export const MESSAGE_QUEUE_STREAM_COMPLETED_EVENT = 'message-queue-stream-completed';

export interface MessageQueueStreamStartedDetail {
  turnId: number;
}

export interface MessageQueueStreamCompletedDetail {
  completionId: string;
  turnId: number | null;
  sequence: number | null;
}
