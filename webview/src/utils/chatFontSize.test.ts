import { beforeEach, describe, expect, it } from 'vitest';
import {
  CHAT_FONT_SIZE_CSS_VARIABLE,
  applyChatFontSize,
  applyChatFontSizeJson,
  isValidChatFontSize,
} from './chatFontSize';

describe('chatFontSize', () => {
  beforeEach(() => {
    document.documentElement.style.removeProperty(CHAT_FONT_SIZE_CSS_VARIABLE);
  });

  describe('isValidChatFontSize', () => {
    it('accepts followEditor and offered px sizes', () => {
      expect(isValidChatFontSize('followEditor')).toBe(true);
      expect(isValidChatFontSize('13')).toBe(true);
      expect(isValidChatFontSize('20')).toBe(true);
    });

    it('rejects out-of-range and malformed values', () => {
      expect(isValidChatFontSize('9')).toBe(false);
      expect(isValidChatFontSize('25')).toBe(false);
      expect(isValidChatFontSize('abc')).toBe(false);
      expect(isValidChatFontSize('')).toBe(false);
    });
  });

  describe('applyChatFontSize', () => {
    it('sets an absolute px variable for numeric sizes', () => {
      applyChatFontSize('14');
      expect(
        document.documentElement.style.getPropertyValue(CHAT_FONT_SIZE_CSS_VARIABLE)
      ).toBe('14px');
    });

    it('removes the variable for followEditor so the editor size applies', () => {
      applyChatFontSize('16');
      applyChatFontSize('followEditor');
      expect(
        document.documentElement.style.getPropertyValue(CHAT_FONT_SIZE_CSS_VARIABLE)
      ).toBe('');
    });
  });

  describe('applyChatFontSizeJson', () => {
    it('applies a numeric payload and returns the normalized value', () => {
      const applied = applyChatFontSizeJson(JSON.stringify({ chatFontSize: '13' }));
      expect(applied).toBe('13');
      expect(
        document.documentElement.style.getPropertyValue(CHAT_FONT_SIZE_CSS_VARIABLE)
      ).toBe('13px');
    });

    it('applies a followEditor payload by clearing the variable', () => {
      applyChatFontSizeJson(JSON.stringify({ chatFontSize: '13' }));
      const applied = applyChatFontSizeJson(JSON.stringify({ chatFontSize: 'followEditor' }));
      expect(applied).toBe('followEditor');
      expect(
        document.documentElement.style.getPropertyValue(CHAT_FONT_SIZE_CSS_VARIABLE)
      ).toBe('');
    });

    it('returns null and keeps styles untouched for invalid payloads', () => {
      applyChatFontSize('15');
      expect(applyChatFontSizeJson(JSON.stringify({ chatFontSize: '999' }))).toBeNull();
      expect(applyChatFontSizeJson('not-json')).toBeNull();
      expect(applyChatFontSizeJson(undefined)).toBeNull();
      expect(
        document.documentElement.style.getPropertyValue(CHAT_FONT_SIZE_CSS_VARIABLE)
      ).toBe('15px');
    });
  });
});
