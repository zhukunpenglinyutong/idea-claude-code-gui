import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import GenericToolBlock from './GenericToolBlock';

const hookMocks = vi.hoisted(() => ({
  useResolvedFileLinkTooltip: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('../../hooks/useIsToolDenied', () => ({
  useIsToolDenied: () => false,
}));

vi.mock('../../utils/bridge', () => ({
  openFile: vi.fn(),
}));

vi.mock('../../hooks/useResolvedFileLinkTooltip', () => ({
  useResolvedFileLinkTooltip: hookMocks.useResolvedFileLinkTooltip,
}));

describe('GenericToolBlock', () => {
  beforeEach(() => {
    hookMocks.useResolvedFileLinkTooltip.mockReset();
    hookMocks.useResolvedFileLinkTooltip.mockReturnValue({});
  });

  it('keeps search-style tools expandable without showing a chevron icon', () => {
    const { container } = render(
      <GenericToolBlock
        name="glob"
        input={{
          pattern: 'session',
          path: '/tmp',
          case_sensitive: true,
        }}
      />,
    );

    expect(container.querySelector('.tool-chevron')).toBeNull();
    expect(container.querySelector('.task-details-accordion')?.classList.contains('expanded')).toBe(false);

    fireEvent.click(container.querySelector('.task-header') as HTMLElement);

    expect(container.querySelector('.task-details-accordion')?.classList.contains('expanded')).toBe(true);
    expect(screen.getByText('case_sensitive')).toBeTruthy();
    expect(screen.getByText('true')).toBeTruthy();
  });

  it('keeps other expandable generic tools clickable without showing a chevron icon', () => {
    const { container } = render(
      <GenericToolBlock
        name="webfetch"
        input={{
          url: 'https://example.com',
          prompt: 'Summarize this page',
        }}
      />,
    );

    expect(container.querySelector('.tool-chevron')).toBeNull();

    fireEvent.click(container.querySelector('.task-header') as HTMLElement);

    expect(container.querySelector('.task-details-accordion')?.classList.contains('expanded')).toBe(true);
    expect(screen.getByText('prompt')).toBeTruthy();
    expect(screen.getByText('Summarize this page')).toBeTruthy();
  });

  it('configures each apply_patch file link independently', () => {
    render(
      <GenericToolBlock
        name="apply_patch"
        input={{
          input: [
            '*** Begin Patch',
            '*** Update File: webview/src/App.tsx',
            '@@',
            '*** Update File: webview/src/main.tsx',
            '@@',
            '*** End Patch',
          ].join('\n'),
        }}
      />,
    );

    expect(hookMocks.useResolvedFileLinkTooltip).toHaveBeenCalledWith('webview/src/App.tsx', 'webview/src/App.tsx');
    expect(hookMocks.useResolvedFileLinkTooltip).toHaveBeenCalledWith('webview/src/main.tsx', 'webview/src/main.tsx');
  });

  it('passes absolute apply_patch paths through to the tooltip', () => {
    const absolutePath = 'C:\\Users\\me\\.ssh\\config';

    render(
      <GenericToolBlock
        name="apply_patch"
        input={{
          input: [
            '*** Begin Patch',
            `*** Update File: ${absolutePath}`,
            '@@',
            '*** End Patch',
          ].join('\n'),
        }}
      />,
    );

    // Local IDE plugin — absolute paths are not sensitive. Pass the path as
    // both the link target and the fallback display text so the tooltip can
    // still show the user where the link points before the backend resolves.
    expect(hookMocks.useResolvedFileLinkTooltip).toHaveBeenCalledWith(absolutePath, absolutePath);
  });

  it('caps huge param values instead of dumping them into the DOM', () => {
    const hugeContent = 'x'.repeat(50_000);
    const { container } = render(
      <GenericToolBlock
        name="Write"
        input={{
          file_path: '/tmp/generated.ts',
          content: hugeContent,
        }}
      />,
    );

    fireEvent.click(container.querySelector('.task-header') as HTMLElement);

    const fieldContent = container.querySelector('.task-field-content');
    expect(fieldContent?.textContent?.length).toBeLessThan(4100);
    expect(fieldContent?.textContent?.endsWith('… (+46000 more chars)')).toBe(true);
  });

  it('renders nested tool_result images and makes the card expandable', () => {
    const { container } = render(
      <GenericToolBlock
        name="Read"
        input={{ file_path: '/tmp/screenshot.png' }}
        result={{
          type: 'tool_result',
          tool_use_id: 'toolu_img',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } } as never,
          ],
        }}
      />,
    );

    // Image-count hint in the header even though there are no other params
    expect(container.querySelector('.codicon-file-media')).toBeTruthy();
    expect(container.querySelector('.task-details-accordion')).toBeTruthy();

    fireEvent.click(container.querySelector('.task-header') as HTMLElement);

    const img = container.querySelector('.task-details-accordion img') as HTMLImageElement;
    expect(img).toBeTruthy();
    expect(img.src).toBe('data:image/png;base64,iVBORw0KGgo=');
  });
});
