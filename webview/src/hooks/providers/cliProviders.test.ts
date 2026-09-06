import { describe, expect, it } from 'vitest';
import { isCliOnlyProvider, normalizeCliPermissionMode, ompModeForModelId } from './cliProviders';
import { OMP_ROLE_MODELS } from '../../components/ChatInputBox/types';

describe('normalizeCliPermissionMode', () => {
  it('preserves plan/smol/slow for the omp provider (model roles)', () => {
    expect(normalizeCliPermissionMode('plan', 'omp')).toBe('plan');
    expect(normalizeCliPermissionMode('smol', 'omp')).toBe('smol');
    expect(normalizeCliPermissionMode('slow', 'omp')).toBe('slow');
    expect(normalizeCliPermissionMode('default', 'omp')).toBe('default');
    expect(normalizeCliPermissionMode('auto', 'omp')).toBe('default');
    expect(normalizeCliPermissionMode('autoEdit', 'omp')).toBe('default');
    expect(normalizeCliPermissionMode('acceptEdits', 'omp')).toBe('acceptEdits');
  });

  it('keeps coercing unsupported plan/auto modes to default for the other CLI providers', () => {
    for (const provider of ['pi', 'grok', 'kimi', 'opencode']) {
      expect(normalizeCliPermissionMode('plan', provider)).toBe('default');
      expect(normalizeCliPermissionMode('auto', provider)).toBe('default');
      expect(normalizeCliPermissionMode('autoEdit', provider)).toBe('acceptEdits');
    }
  });

  it('coerces unsupported plan/auto modes to default when no provider is given (legacy callers)', () => {
    expect(normalizeCliPermissionMode('plan')).toBe('default');
    expect(normalizeCliPermissionMode('auto')).toBe('default');
    expect(normalizeCliPermissionMode('default')).toBe('default');
  });

  it('passes non-plan modes through unchanged for other providers', () => {
    expect(normalizeCliPermissionMode('acceptEdits', 'pi')).toBe('acceptEdits');
    expect(normalizeCliPermissionMode('autoEdit', 'pi')).toBe('acceptEdits');
    expect(normalizeCliPermissionMode('bypassPermissions', 'grok')).toBe('bypassPermissions');
  });
});

describe('ompModeForModelId', () => {
  it('maps static role model ids to the same-named mode', () => {
    expect(ompModeForModelId('smol', OMP_ROLE_MODELS)).toBe('smol');
    expect(ompModeForModelId('slow', OMP_ROLE_MODELS)).toBe('slow');
    expect(ompModeForModelId('plan', OMP_ROLE_MODELS)).toBe('plan');
  });

  it('maps catalog model ids and auto to default', () => {
    expect(ompModeForModelId('github-copilot/claude-fable-5', OMP_ROLE_MODELS)).toBe('default');
    expect(ompModeForModelId('auto', OMP_ROLE_MODELS)).toBe('default');
  });

  it('maps a dynamic role to the same-named mode only when present in roles', () => {
    const roles = [...OMP_ROLE_MODELS, { id: 'designer', label: 'Designer', description: 'opencode-go/deepseek-v4-flash' }];
    expect(ompModeForModelId('designer', roles)).toBe('designer');
    expect(ompModeForModelId('designer', OMP_ROLE_MODELS)).toBe('default');
  });
});

describe('isCliOnlyProvider', () => {
  it('recognizes omp as a CLI-only provider', () => {
    expect(isCliOnlyProvider('omp')).toBe(true);
    expect(isCliOnlyProvider('pi')).toBe(true);
    expect(isCliOnlyProvider('claude')).toBe(false);
    expect(isCliOnlyProvider(undefined)).toBe(false);
  });
});
