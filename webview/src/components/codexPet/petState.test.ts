import { describe, expect, it } from 'vitest';
import {
  isCodexPetErrorStatus,
  isCodexPetToggleCommand,
  resolveCodexPetState,
  shouldToggleCodexPet,
} from './petState';

describe('Codex pet state', () => {
  it('prioritizes active work over stale error-like status text', () => {
    expect(resolveCodexPetState(true, true, true, 'ready')).toBe('thinking');
    expect(resolveCodexPetState(true, true, true, 'turn failed')).toBe('thinking');
    expect(resolveCodexPetState(true, false, false, 'turn failed')).toBe('running');
    expect(resolveCodexPetState(false, true, false, 'turn failed')).toBe('running');
    expect(resolveCodexPetState(false, false, false, 'turn failed')).toBe('idle');
    expect(resolveCodexPetState(false, false, false, 'Error: crashed')).toBe('error');
    expect(resolveCodexPetState(false, false, false, '\u9519\u8bef\uff1a\u5d29\u6e83')).toBe('error');
  });

  it('only treats explicit status errors as pet errors', () => {
    expect(isCodexPetErrorStatus('Error: crashed')).toBe(true);
    expect(isCodexPetErrorStatus('\u9519\u8bef\uff1a\u5d29\u6e83')).toBe(true);
    expect(isCodexPetErrorStatus('\u66f4\u65b0\u6807\u9898\u5931\u8d25')).toBe(false);
    expect(isCodexPetErrorStatus('all completed but one command failed earlier')).toBe(false);
  });

  it('maps active and idle states', () => {
    expect(resolveCodexPetState(true, false, false, '')).toBe('running');
    expect(resolveCodexPetState(false, false, false, 'ready')).toBe('idle');
  });

  it('recognizes only complete pet toggle commands', () => {
    expect(isCodexPetToggleCommand(' /PET ')).toBe(true);
    expect(isCodexPetToggleCommand('/\u5ba0\u7269')).toBe(true);
    expect(isCodexPetToggleCommand('/pet install')).toBe(false);
  });

  it('only consumes pet commands in Codex mode without attachments', () => {
    expect(shouldToggleCodexPet('codex', '/pet', 0)).toBe(true);
    expect(shouldToggleCodexPet('claude', '/pet', 0)).toBe(false);
    expect(shouldToggleCodexPet('codex', '/pet', 1)).toBe(false);
  });
});
