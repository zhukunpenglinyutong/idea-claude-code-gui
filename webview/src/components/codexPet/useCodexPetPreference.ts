import { useCallback, useEffect, useState } from 'react';
import { petBridge } from './petBridge';

export function useCodexPetPreference() {
  const [enabled, setEnabledState] = useState(false);

  useEffect(() => {
    const unsubscribe = petBridge.subscribeConfig((config) => setEnabledState(config.enabled));
    petBridge.getConfig();
    return unsubscribe;
  }, []);

  const setEnabled = useCallback((value: boolean) => {
    setEnabledState(value);
    petBridge.setConfig({ enabled: value });
  }, []);

  const toggle = useCallback(() => {
    setEnabledState((current) => {
      const next = !current;
      petBridge.setConfig({ enabled: next });
      return next;
    });
  }, []);

  return { enabled, setEnabled, toggle };
}
