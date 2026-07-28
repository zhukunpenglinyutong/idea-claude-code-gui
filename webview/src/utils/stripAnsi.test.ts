import { describe, expect, it } from 'vitest';
import { stripAnsi } from './stripAnsi';

describe('stripAnsi', () => {
  it('returns text without escape sequences unchanged', () => {
    const text = 'plain output [31m looks like ansi but is not';
    expect(stripAnsi(text)).toBe(text);
  });

  it('handles empty input', () => {
    expect(stripAnsi('')).toBe('');
  });

  it('strips SGR color codes from vitest failure output', () => {
    const input = '\x1b[41m\x1b[1m FAIL \x1b[22m\x1b[49m src/components/kitchen-pulse/Kitchen360Timeline.spec.tsx';
    expect(stripAnsi(input)).toBe(' FAIL  src/components/kitchen-pulse/Kitchen360Timeline.spec.tsx');
  });

  it('strips dim/color separators used by test reporters', () => {
    const input = '\x1b[31m\x1b[2m⎯⎯⎯⎯⎯⎯[2/5]⎯\x1b[22m\x1b[39m';
    expect(stripAnsi(input)).toBe('⎯⎯⎯⎯⎯⎯[2/5]⎯');
  });

  it('strips multiline colorized output', () => {
    const input = '\x1b[90m168|\x1b[39m   })\x1b[33m;\x1b[39m\n\x1b[31m × auto-loads the older range\x1b[39m';
    expect(stripAnsi(input)).toBe('168|   });\n × auto-loads the older range');
  });

  it('strips CSI sequences with private-mode and intermediate bytes', () => {
    expect(stripAnsi('\x1b[?25lhidden cursor\x1b[?25h')).toBe('hidden cursor');
    expect(stripAnsi('\x1b[2Kcleared line')).toBe('cleared line');
  });

  it('strips OSC sequences terminated by BEL', () => {
    expect(stripAnsi('\x1b]0;window title\x07visible')).toBe('visible');
  });

  it('strips OSC sequences terminated by ST (ESC backslash)', () => {
    expect(stripAnsi('\x1b]8;;https://example.com\x1b\\link text\x1b]8;;\x1b\\')).toBe('link text');
  });

  it('removes lone ESC characters', () => {
    expect(stripAnsi('before\x1bafter')).toBe('beforeafter');
  });

  it('preserves surrounding text exactly', () => {
    const input = 'Test Files \x1b[1m\x1b[32m226 passed\x1b[39m\x1b[22m (226)';
    expect(stripAnsi(input)).toBe('Test Files 226 passed (226)');
  });
});
