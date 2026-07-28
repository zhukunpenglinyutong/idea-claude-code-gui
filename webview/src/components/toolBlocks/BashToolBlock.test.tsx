import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import BashToolBlock from './BashToolBlock';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('../../hooks/useIsToolDenied', () => ({
  useIsToolDenied: () => false,
}));

describe('BashToolBlock', () => {
  it('hides empty placeholders until command details arrive', () => {
    const { container, rerender } = render(<BashToolBlock input={{}} />);

    expect(container.firstChild).toBeNull();

    rerender(<BashToolBlock input={{ command: 'npm test' }} />);
    expect(container.querySelector('.bash-tool-header')).not.toBeNull();

    rerender(<BashToolBlock input={{ command: '  ', description: '\n' }} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders command and stdout text in code-font-targeted nodes', () => {
    const { container } = render(
      <BashToolBlock
        input={{
          command: 'node --version',
        }}
        result={{
          type: 'tool_result',
          content: 'v22.0.0',
        }}
      />,
    );

    fireEvent.click(container.querySelector('.bash-tool-header') as HTMLElement);

    expect(container.querySelector('.bash-command-block')?.textContent).toBe('node --version');
    expect(container.querySelector('.bash-output-text')?.textContent).toBe('v22.0.0');
  });
});
