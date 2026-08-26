import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import styles from './style.module.less';

export type GrokAuthMethod = 'oauth' | 'api_key' | 'auto';

const PLACEHOLDER_JSON = `{
  "env": {
    "XAI_API_KEY": "",
    "GROK_API_KEY": "",
    "GROK_MODELS_BASE_URL": "",
    "GROK_CLI_CHAT_PROXY_BASE_URL": ""
  },
  "authMethod": "oauth"
}`;

const GrokProviderSection = () => {
  const { t } = useTranslation();
  const [jsonConfig, setJsonConfig] = useState('');
  const [jsonError, setJsonError] = useState('');
  const [saving, setSaving] = useState(false);
  const savePendingRef = useRef(false);

  useEffect(() => {
    const handler = (jsonStr: string) => {
      try {
        const data = typeof jsonStr === 'string' ? JSON.parse(jsonStr) : jsonStr;
        // XAI_API_KEY is the official xAI env; GROK_API_KEY is a compatible alias.
        // Runtime accepts either (and usually writes both when injecting a key).
        const apiKey = data?.apiKey || '';
        // The backend sends `"env": {}` (never null) when nothing is stored —
        // `{}` is truthy, so an emptiness check (not `||`) decides whether the
        // stored env replaces the flat-field template below.
        const hasEnv = !!data?.env && Object.keys(data.env).length > 0;
        let env: Record<string, string>;
        if (hasEnv) {
          env = { ...data.env };
          // Legacy configs can carry a flat apiKey with no alias in env —
          // surface the stored key so a save round-trips it instead of
          // silently erasing it (`apiKey: ''` deletes the stored key).
          if (!env.XAI_API_KEY && !env.GROK_API_KEY) {
            env.XAI_API_KEY = apiKey;
            env.GROK_API_KEY = apiKey;
          }
        } else {
          env = {
            XAI_API_KEY: apiKey,
            GROK_API_KEY: apiKey,
            GROK_MODELS_BASE_URL: data?.apiBaseUrl || '',
            GROK_CLI_CHAT_PROXY_BASE_URL: data?.oauthBaseUrl || '',
          };
        }
        const configObj = {
          env,
          authMethod: data?.authMethod || 'oauth'
        };
        setJsonConfig(JSON.stringify(configObj, null, 2));
        // After a save the backend pushes the persisted config back — release
        // the saving state on that ack instead of a blind timer.
        if (savePendingRef.current) {
          savePendingRef.current = false;
          setSaving(false);
        }
      } catch {
        // ignore parse errors
      }
    };
    window.updateGrokAuthConfig = handler;
    window.sendToJava?.('get_grok_auth_config:');
    return () => {
      if (window.updateGrokAuthConfig === handler) {
        delete window.updateGrokAuthConfig;
      }
    };
  }, []);

  const handleJsonChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setJsonConfig(e.target.value);
    setJsonError('');
  };

  const handleSave = useCallback(() => {
    try {
      const parsed = JSON.parse(jsonConfig);
      const env = parsed.env || {};
      const next = {
        authMethod: parsed.authMethod || 'oauth',
        apiKey: env.XAI_API_KEY || env.GROK_API_KEY || '',
        apiBaseUrl: env.GROK_MODELS_BASE_URL || '',
        oauthBaseUrl: env.GROK_CLI_CHAT_PROXY_BASE_URL || '',
        env: env // send custom env down to backend
      };

      setSaving(true);
      savePendingRef.current = true;
      window.sendToJava?.(`set_grok_auth_config:${JSON.stringify(next)}`);
      // Safety net only — the real release is the config push-back ack above.
      setTimeout(() => {
        if (savePendingRef.current) {
          savePendingRef.current = false;
          setSaving(false);
        }
      }, 5000);
      setJsonError('');
    } catch {
      setJsonError(t('settings.grok.invalidJson'));
    }
  }, [jsonConfig, t]);

  return (
    <div className={styles.grokSection}>
      <div className={styles.header}>
        <h4 className={styles.title}>{t('settings.grok.title')}</h4>
        <p className={styles.desc}>{t('settings.grok.desc')}</p>
      </div>

      <div className={styles.card}>
        <div className={styles.cardBody}>
          <div className={styles.editorHint}>{t('settings.grok.editorHint')}</div>
          <textarea
            className={styles.editorTextarea}
            value={jsonConfig}
            onChange={handleJsonChange}
            placeholder={PLACEHOLDER_JSON}
            spellCheck={false}
          />
          {jsonError && (
            <p className={styles.editorError}>
              <span className="codicon codicon-error" />
              {jsonError}
            </p>
          )}

          <div className={styles.saveRow}>
            <button
              type="button"
              className={styles.saveBtn}
              onClick={handleSave}
              disabled={saving}
            >
              {saving ? t('settings.grok.saving') : t('settings.grok.save')}
            </button>
            {/* Saving restarts the Grok runtime (new credentials only apply
                to a fresh daemon) — an in-flight Grok conversation dies. */}
            <p className={styles.editorHint}>{t('settings.grok.saveHint')}</p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default GrokProviderSection;
