/**
 * forceWebviewRepaint
 *
 * Clears JCEF native-rendering ghosting on macOS by forcing a full-viewport
 * re-rasterization.
 *
 * Why this is needed: on macOS JCEF runs in native (windowed) rendering mode
 * (see JBCefBrowserFactory.determineOsrMode). In that mode Chromium's compositor
 * sometimes fails to invalidate the region a compositing-layer element occupied
 * after React unmounts it or its parent reflows — leaving stale pixels (ghosting).
 * Typical culprits: position:fixed/animated overlays (the changelog dialog) and
 * input-box header content that grows/shrinks (open-source banner, attachments).
 *
 * The fix reuses the zoom-nudge technique already proven in main.tsx `forceReapply`
 * ("Toggle inline zoom to ensure Chromium/JCEF re-applies scaling"), but applies it
 * unconditionally. A timer fallback handles deprioritized/hidden JCEF surfaces where
 * requestAnimationFrame can remain suspended during tab activation.
 *
 * @param _reason optional label for debugging; intentionally unused at runtime.
 */
export function forceWebviewRepaint(_reason?: string): void {
  const app = document.getElementById('app');
  if (!app) return;

  const appStyle = app.style as CSSStyleDeclaration & { zoom?: string };
  // Restore target: align with the scale main.tsx maintains via --font-scale.
  const expectedScale = getComputedStyle(document.documentElement)
    .getPropertyValue('--font-scale')
    .trim();

  let repainted = false;
  const repaint = () => {
    if (repainted) return;
    repainted = true;
    const restore = expectedScale || appStyle.zoom || '1';
    const numericRestore = Number.parseFloat(restore);
    const nudge = Number.isFinite(numericRestore) && Math.abs(numericRestore - 1) < 0.0001
      ? '0.999'
      : '1';
    appStyle.zoom = nudge;
    void app.offsetHeight;
    appStyle.zoom = restore;
    window.dispatchEvent(new Event('resize'));
  };

  // Keep the normal double-rAF path for post-React layout, but do not rely on it:
  // JCEF can suspend rAF while a native-rendered content tab is hidden/black.
  const fallbackId = window.setTimeout(repaint, 50);
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      window.clearTimeout(fallbackId);
      repaint();
    });
  });
}
