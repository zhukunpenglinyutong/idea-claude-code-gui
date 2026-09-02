import { fireEvent, render, screen } from '@testing-library/react';
import type { QueuedMessage } from '../../hooks/useMessageQueue';
import { MessageQueue } from './MessageQueue';

const queue: QueuedMessage[] = [
  { id: 'first', content: '第一条，下一条执行', queuedAt: 1 },
  { id: 'last', content: '第二条，最后执行', queuedAt: 2 },
];

function renderQueue(overrides: Partial<React.ComponentProps<typeof MessageQueue>> = {}) {
  const props = {
    queue,
    onRemove: vi.fn(),
    onUpdate: vi.fn(),
    onMoveUp: vi.fn(),
    onMoveDown: vi.fn(),
    onMoveToFront: vi.fn(),
    onMoveToBack: vi.fn(),
    onInsert: vi.fn(),
    onInterrupt: vi.fn(),
    ...overrides,
  };

  return { ...render(<MessageQueue {...props} />), props };
}

describe('MessageQueue', () => {
  it('uses reverse display while queue number 1 remains the next execution', () => {
    renderQueue();

    const items = document.querySelectorAll('.message-queue-item');
    expect(items[0].textContent).toContain('2');
    expect(items[0].textContent).toContain('第二条，最后执行');
    expect(items[1].textContent).toContain('1');
    expect(items[1].textContent).toContain('第一条，下一条执行');
  });

  it('renders boundary movement controls with correct labels and disabled states', () => {
    renderQueue();

    const moveUp = screen.getAllByRole('button', { name: '上移一位（更晚执行）' });
    const moveDown = screen.getAllByRole('button', { name: '下移一位（更早执行）' });
    const moveToFront = screen.getAllByRole('button', { name: '移动到队首（下一条执行）' });
    const moveToBack = screen.getAllByRole('button', { name: '移动到队尾（最后执行）' });

    expect((moveUp[0] as HTMLButtonElement).disabled).toBe(true);
    expect((moveUp[1] as HTMLButtonElement).disabled).toBe(false);
    expect((moveDown[0] as HTMLButtonElement).disabled).toBe(false);
    expect((moveDown[1] as HTMLButtonElement).disabled).toBe(true);
    expect((moveToFront[0] as HTMLButtonElement).disabled).toBe(false);
    expect((moveToFront[1] as HTMLButtonElement).disabled).toBe(true);
    expect((moveToBack[0] as HTMLButtonElement).disabled).toBe(true);
    expect((moveToBack[1] as HTMLButtonElement).disabled).toBe(false);
  });

  it('edits a queue item, disallows blank saves, and can cancel changes', () => {
    const { props } = renderQueue();

    fireEvent.click(screen.getAllByRole('button', { name: '编辑本条消息' })[0]);
    const editor = screen.getByRole('textbox', { name: '编辑队列消息' });
    fireEvent.change(editor, { target: { value: '  修改后的消息  ' } });
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));

    expect(props.onUpdate).toHaveBeenCalledWith('last', '修改后的消息');

    fireEvent.click(screen.getAllByRole('button', { name: '编辑本条消息' })[0]);
    fireEvent.change(screen.getByRole('textbox', { name: '编辑队列消息' }), { target: { value: '   ' } });
    expect((screen.getByRole('button', { name: '保存修改' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '取消编辑' }));

    expect(screen.queryByRole('textbox', { name: '编辑队列消息' })).toBeNull();
    expect(props.onUpdate).toHaveBeenCalledTimes(1);
  });

  it('maps visual movement controls to the inverse logical queue operations', () => {
    const { props } = renderQueue();

    fireEvent.click(screen.getAllByRole('button', { name: '上移一位（更晚执行）' })[1]);
    fireEvent.click(screen.getAllByRole('button', { name: '下移一位（更早执行）' })[0]);

    expect(props.onMoveDown).toHaveBeenCalledWith('first');
    expect(props.onMoveUp).toHaveBeenCalledWith('last');
  });

  it('routes insert and remove actions to their callbacks', () => {
    const { props } = renderQueue();

    fireEvent.click(screen.getAllByRole('button', { name: '插入到下一次执行' })[0]);
    fireEvent.click(screen.getAllByRole('button', { name: '从队列移除' })[1]);

    expect(props.onInsert).toHaveBeenCalledWith('last');
    expect(props.onRemove).toHaveBeenCalledWith('first');
  });

  it('routes the interrupt action to its callback with an accessible label', () => {
    const { props } = renderQueue();

    fireEvent.click(screen.getAllByRole('button', { name: '打断当前任务并优先执行本条' })[0]);

    expect(props.onInterrupt).toHaveBeenCalledWith('last');
  });
});
