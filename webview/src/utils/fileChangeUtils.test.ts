import { describe, expect, it } from 'vitest';
import {
  extractFilePath,
  extractStrings,
  determineFileStatus,
  isSuccessfulResult,
} from './fileChangeUtils';
import type { EditOperation } from '../types/fileChanges';
import type { ToolResultBlock } from '../types';

describe('extractFilePath', () => {
  it('returns filePath when present', () => {
    expect(extractFilePath({ filePath: '/a/b.ts' })).toBe('/a/b.ts');
  });

  it('returns file_path when present', () => {
    expect(extractFilePath({ file_path: '/a/b.ts' })).toBe('/a/b.ts');
  });

  it('returns path when present', () => {
    expect(extractFilePath({ path: '/a/b.ts' })).toBe('/a/b.ts');
  });

  it('returns target_file when present', () => {
    expect(extractFilePath({ target_file: '/a/b.ts' })).toBe('/a/b.ts');
  });

  it('returns targetFile when present', () => {
    expect(extractFilePath({ targetFile: '/a/b.ts' })).toBe('/a/b.ts');
  });

  it('returns notebook_path when present', () => {
    expect(extractFilePath({ notebook_path: '/a/b.ipynb' })).toBe('/a/b.ipynb');
  });

  it('prefers filePath over other candidates', () => {
    expect(extractFilePath({ path: '/wrong.ts', filePath: '/right.ts' })).toBe('/right.ts');
  });

  it('returns null when no path field exists', () => {
    expect(extractFilePath({})).toBeNull();
  });

  it('returns null when none of the values is a string', () => {
    expect(extractFilePath({ path: 42 })).toBeNull();
  });
});

describe('extractStrings', () => {
  it('extracts old_string and new_string', () => {
    const result = extractStrings({ old_string: 'old', new_string: 'new' });
    expect(result.oldString).toBe('old');
    expect(result.newString).toBe('new');
  });

  it('falls back to oldString/newString', () => {
    const result = extractStrings({ oldString: 'o', newString: 'n' });
    expect(result.oldString).toBe('o');
    expect(result.newString).toBe('n');
  });

  it('falls back to content for newString (write tool)', () => {
    const result = extractStrings({ content: 'file content' });
    expect(result.oldString).toBe('');
    expect(result.newString).toBe('file content');
  });

  it('extracts replaceAll', () => {
    const result = extractStrings({ old_string: 'a', new_string: 'b', replace_all: true });
    expect(result.replaceAll).toBe(true);
  });

  it('handles replaceAll with camelCase key', () => {
    const result = extractStrings({ oldString: 'a', newString: 'b', replaceAll: false });
    expect(result.replaceAll).toBe(false);
  });
});

describe('determineFileStatus', () => {
  const makeOp = (overrides?: Partial<EditOperation>): EditOperation => ({
    toolName: 'edit',
    oldString: 'old',
    newString: 'new',
    additions: 0,
    deletions: 0,
    ...overrides,
  });

  it('returns M for empty operations', () => {
    expect(determineFileStatus([])).toBe('M');
  });

  it('returns M for standard edit', () => {
    expect(determineFileStatus([makeOp()])).toBe('M');
  });

  it('returns A for write tool', () => {
    expect(determineFileStatus([makeOp({ toolName: 'write' })])).toBe('A');
  });

  it('returns A for create_file tool', () => {
    expect(determineFileStatus([makeOp({ toolName: 'create_file' })])).toBe('A');
  });

  it('returns A for file creation with empty oldString', () => {
    expect(determineFileStatus([makeOp({ oldString: '', newString: 'new content' })])).toBe('A');
  });
});

describe('isSuccessfulResult', () => {
  const makeResult = (overrides?: Partial<ToolResultBlock>): ToolResultBlock | null | undefined => {
    if (overrides === null) return null;
    if (overrides === undefined) return undefined;
    return {
      type: 'tool_result' as const,
      content: '',
      tool_use_id: 't1',
      ...overrides,
    };
  };

  it('returns true for successful result', () => {
    expect(isSuccessfulResult(makeResult({}))).toBe(true);
  });

  it('returns false for error result', () => {
    expect(isSuccessfulResult(makeResult({ is_error: true }))).toBe(false);
  });

  it('returns false for null', () => {
    expect(isSuccessfulResult(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isSuccessfulResult(undefined)).toBe(false);
  });
});
