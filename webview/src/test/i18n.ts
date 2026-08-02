import zh from '../i18n/locales/zh.json';
import en from '../i18n/locales/en.json';
import zhTW from '../i18n/locales/zh-TW.json';

export type TestLang = 'zh' | 'en' | 'zh-TW';

const resources: Record<TestLang, Record<string, unknown>> = {
  zh: zh as unknown as Record<string, unknown>,
  en: en as unknown as Record<string, unknown>,
  'zh-TW': zhTW as unknown as Record<string, unknown>,
};

/**
 * Builds a t() function from the real locale resources for component tests.
 * Missing keys surface as the raw key so tests fail loudly instead of hiding
 * incomplete translations.
 */
export function makeTestT(lang: TestLang): (key: string, vars?: Record<string, unknown>) => string {
  const resource = resources[lang];
  return (key: string, vars?: Record<string, unknown>) => {
    let node: unknown = resource;
    for (const part of key.split('.')) {
      if (node !== null && typeof node === 'object' && part in (node as Record<string, unknown>)) {
        node = (node as Record<string, unknown>)[part];
      } else {
        return key;
      }
    }
    let text = typeof node === 'string' ? node : key;
    if (vars !== undefined) {
      for (const [name, value] of Object.entries(vars)) {
        text = text.split(`{{${name}}}`).join(String(value));
      }
    }
    return text;
  };
}
