import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OMP_ROLE_MODELS, type ModelInfo } from '../types';
import { ModeSelect } from './ModeSelect';

const LABELS: Record<string, string> = {
  'modes.default.label': 'Default Mode',
  'modes.default.shortLabel': 'Default',
  'modes.auto.label': 'Auto Mode',
  'modes.auto.shortLabel': 'Auto',
  'modes.bypassPermissions.label': 'Full Auto',
  'modes.bypassPermissions.shortLabel': 'Full Auto',
  'codexModes.auto.label': 'Approve for me',
  'codexModes.auto.shortLabel': 'Auto',
  'ompModes.default.label': 'Default',
  'ompModes.smol.label': 'Smol',
  'ompModes.slow.label': 'Slow',
  'ompModes.plan.label': 'Plan',
};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => LABELS[key] ?? options?.defaultValue ?? key,
    i18n: { exists: (key: string) => key in LABELS },
  }),
}));

/** Mutable roles the useOmpRoles mock returns — static fallback by default. */
const ompRolesState = vi.hoisted(() => ({ roles: [] as ModelInfo[] }));

vi.mock('../../../hooks/providers/useCliModels', () => ({
  useOmpRoles: () => (ompRolesState.roles.length > 0 ? ompRolesState.roles : OMP_ROLE_MODELS),
}));

function openAndGetOptionIds(provider: string): string[] {
  render(<ModeSelect value="default" onChange={vi.fn()} provider={provider} />);
  fireEvent.click(screen.getByRole('button'));
  return screen
    .getAllByTestId(/^mode-option-/)
    .map((el) => el.getAttribute('data-testid')!.replace('mode-option-', ''));
}

describe('ModeSelect', () => {
  beforeEach(() => {
    ompRolesState.roles = [];
  });

  it('shows exactly default/smol/slow/plan (in order) for the omp provider before roles load', () => {
    expect(openAndGetOptionIds('omp')).toEqual(['default', 'smol', 'slow', 'plan']);
  });

  it('renders OMP model-role labels from the ompModes i18n keys', () => {
    render(<ModeSelect value="default" onChange={vi.fn()} provider="omp" />);
    fireEvent.click(screen.getByRole('button'));

    expect(screen.getByText('Smol')).toBeTruthy();
    expect(screen.getByText('Slow')).toBeTruthy();
    expect(screen.getByText('Plan')).toBeTruthy();
  });

  it('shows Default + dynamic roles for omp, with raw label/selector for unknown roles', () => {
    ompRolesState.roles = [
      { id: 'smol', label: 'Smol', description: 'openai/gpt-5-mini' },
      { id: 'designer', label: 'Designer', description: 'opencode-go/deepseek-v4-flash' },
    ];
    const onChange = vi.fn();
    render(<ModeSelect value="designer" onChange={onChange} provider="omp" />);

    // Collapsed button shows the selected dynamic role with raw capitalized label.
    expect(screen.getByRole('button').textContent).toContain('Designer');

    fireEvent.click(screen.getByRole('button'));
    const ids = screen
      .getAllByTestId(/^mode-option-/)
      .map((el) => el.getAttribute('data-testid')!.replace('mode-option-', ''));
    expect(ids).toEqual(['default', 'smol', 'designer']);
    // Known role keeps its i18n label; the dynamic role shows the raw
    // capitalized id (button + option) and the resolved selector as description.
    expect(screen.getByText('Smol')).toBeTruthy();
    expect(screen.getAllByText('Designer').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('opencode-go/deepseek-v4-flash')).toBeTruthy();

    // Selecting a dynamic role fires onChange with the role id.
    fireEvent.click(screen.getByTestId('mode-option-designer'));
    expect(onChange).toHaveBeenCalledWith('designer');
  });

  it('translates known dynamic role ids via ompModes keys when roles carry extra entries', () => {
    ompRolesState.roles = [
      { id: 'plan', label: 'ignored payload label', description: 'openai/o4' },
      { id: 'vision', label: 'Vision', description: 'openai/gpt-5-vision' },
    ];
    render(<ModeSelect value="default" onChange={vi.fn()} provider="omp" />);
    fireEvent.click(screen.getByRole('button'));

    expect(screen.getByText('Plan')).toBeTruthy();
    expect(screen.getByText('Vision')).toBeTruthy();
  });

  it('shows a compact short label on the trigger and the full label in the menu', () => {
    render(<ModeSelect value="default" onChange={vi.fn()} provider="claude" />);

    expect(screen.getByRole('button').textContent).toContain('Default');
    expect(screen.getByRole('button').textContent).not.toContain('Default Mode');

    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('Default Mode')).toBeTruthy();
  });

  it('renders native auto and Full Auto as separate Claude choices', () => {
    render(<ModeSelect value="auto" onChange={vi.fn()} provider="claude" />);
    expect(screen.getByRole('button').textContent).toContain('Auto');
    expect(screen.getByRole('button').className).not.toContain('mode-full-auto-active');

    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('Auto Mode')).toBeTruthy();
    expect(screen.getByText('Full Auto')).toBeTruthy();
  });

  it('uses the warning treatment only for Full Auto', () => {
    render(<ModeSelect value="bypassPermissions" onChange={vi.fn()} provider="claude" />);
    expect(screen.getByRole('button').className).toContain('mode-full-auto-active');
  });

  it('hides smol/slow for the claude provider while keeping native auto and Full Auto distinct', () => {
    expect(openAndGetOptionIds('claude')).toEqual(['default', 'plan', 'acceptEdits', 'auto', 'bypassPermissions']);
  });

  it('shows Codex native auto review alongside Full Auto', () => {
    expect(openAndGetOptionIds('codex')).toEqual(['default', 'acceptEdits', 'auto', 'bypassPermissions']);
    cleanup();

    render(<ModeSelect value="auto" onChange={vi.fn()} provider="codex" />);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('Approve for me')).toBeTruthy();
    expect(screen.getByText('Full Auto')).toBeTruthy();
  });

  it('hides native auto when the installed Codex SDK is below the supported version', () => {
    render(
      <ModeSelect
        value="default"
        onChange={vi.fn()}
        provider="codex"
        codexNativeAutoReviewAvailable={false}
      />,
    );
    fireEvent.click(screen.getByRole('button'));
    expect(screen.queryByTestId('mode-option-auto')).toBeNull();
    expect(screen.getByTestId('mode-option-bypassPermissions')).toBeTruthy();
  });

});
