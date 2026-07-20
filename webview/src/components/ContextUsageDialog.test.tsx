import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import ContextUsageDialog, { type ContextUsageData } from './ContextUsageDialog';

const translationMap: Record<string, string> = {
  'contextUsage.title': '上下文使用',
  'contextUsage.loading': '正在加载上下文使用情况...',
  'contextUsage.autoCompactEnabledWithThreshold': '自动压缩已启用 (80%)',
  'contextUsage.categories.systemPrompt': '系统提示词',
  'contextUsage.categories.autoCompactBuffer': '自动压缩缓冲区',
  'contextUsage.categories.freeSpace': '空闲空间',
  'contextUsage.sections.mcpTools': 'MCP 工具 (1)',
  'contextUsage.table.tool': '工具',
  'contextUsage.table.server': '服务器',
  'contextUsage.table.tokens': '令牌',
  'common.close': '关闭',
};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => translationMap[key] ?? options?.defaultValue ?? key,
    i18n: { language: 'zh' },
  }),
}));

const sampleData: ContextUsageData = {
  categories: [
    { name: 'System prompt', tokens: 1200, color: 'promptBorder' },
    { name: 'Free space', tokens: 800, color: 'inactive' },
    { name: 'Autocompact buffer', tokens: 200, color: 'warning' },
  ],
  gridRows: [[
    {
      color: 'promptBorder',
      isFilled: true,
      categoryName: 'System prompt',
      tokens: 1200,
      percentage: 60,
      squareFullness: 1,
    },
    {
      color: 'inactive',
      isFilled: false,
      categoryName: 'Free space',
      tokens: 800,
      percentage: 40,
      squareFullness: 0.4,
    },
  ]],
  totalTokens: 1200,
  maxTokens: 2000,
  rawMaxTokens: 2000,
  percentage: 60,
  model: 'claude-sonnet-4-6',
  memoryFiles: [],
  mcpTools: [{ name: 'read_file', serverName: 'workspace', tokens: 50 }],
  agents: [],
  skills: undefined,
  isAutoCompactEnabled: true,
  autoCompactThreshold: 1600, // 80% of 2000 maxTokens
};

describe('ContextUsageDialog', () => {
  it('renders accessible dialog semantics and focuses the close button', async () => {
    render(
      <ContextUsageDialog
        isOpen
        isLoading={false}
        data={sampleData}
        onClose={() => {}}
      />,
    );

    const dialog = screen.getByRole('dialog', { name: '上下文使用' });
    expect(dialog).toBeTruthy();

    const closeButton = screen.getByRole('button', { name: '关闭' });
    expect(closeButton).toBeTruthy();

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.activeElement).toBe(closeButton);
  });

  it('uses translated labels for summary, legend and table content', () => {
    render(
      <ContextUsageDialog
        isOpen
        isLoading={false}
        data={sampleData}
        onClose={() => {}}
      />,
    );

    expect(screen.getByText('自动压缩已启用 (80%)')).toBeTruthy();
    expect(screen.getByText('系统提示词')).toBeTruthy();
    expect(screen.getByText('自动压缩缓冲区')).toBeTruthy();
    expect(screen.getByText('空闲空间')).toBeTruthy();
    expect(screen.getByText('MCP 工具 (1)')).toBeTruthy();
    expect(screen.getByText('工具')).toBeTruthy();
    expect(screen.getByText('服务器')).toBeTruthy();
    expect(screen.getAllByText('令牌').length).toBeGreaterThan(0);
  });

  it('clamps visual percentages while preserving raw token counts', () => {
    const { container } = render(
      <ContextUsageDialog
        isOpen
        isLoading={false}
        data={{ ...sampleData, totalTokens: 2400, percentage: 120 }}
        onClose={() => {}}
      />,
    );

    expect(container.querySelector('.context-usage-tokens')?.textContent).toBe('2.4k / 2.0k (100%)');
  });

  it('uses a finite fallback opacity for invalid square fullness', () => {
    const invalidData: ContextUsageData = {
      ...sampleData,
      gridRows: [[{ ...sampleData.gridRows[0][0], squareFullness: Number.NaN }]],
    };
    const { container } = render(
      <ContextUsageDialog isOpen isLoading={false} data={invalidData} onClose={() => {}} />,
    );

    const square = container.querySelector<HTMLElement>('.context-usage-grid-cell.partial');
    expect(square?.style.opacity).toBe('0.5');
  });
});
