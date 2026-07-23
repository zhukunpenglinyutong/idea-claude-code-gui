export type CodexPetState = 'idle' | 'thinking' | 'running' | 'success' | 'error';

export function resolveCodexPetState(
  loading: boolean,
  streamingActive: boolean,
  isThinking: boolean,
  status: string,
): Exclude<CodexPetState, 'success'> {
  if (isThinking) return 'thinking';
  if (loading || streamingActive) return 'running';
  if (isCodexPetErrorStatus(status)) return 'error';
  return 'idle';
}

export function isCodexPetErrorStatus(status: string): boolean {
  const text = status.trim();
  return /^error\s*:/i.test(text)
    || new RegExp(`^\\u9519\\u8bef\\s*[\\u003a\\uff1a]`).test(text);
}

export function isCodexPetToggleCommand(content: string): boolean {
  const command = content.trim().toLowerCase();
  return command === '/pet' || command === '/\u5ba0\u7269';
}

export function shouldToggleCodexPet(
  provider: string,
  content: string,
  attachmentCount: number,
): boolean {
  return provider === 'codex' && attachmentCount === 0 && isCodexPetToggleCommand(content);
}
