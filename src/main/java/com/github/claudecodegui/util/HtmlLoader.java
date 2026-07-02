package com.github.claudecodegui.util;

import com.intellij.openapi.diagnostic.Logger;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Base64;

/**
 * HTML loader.
 * Handles HTML file loading and local library injection.
 */
public class HtmlLoader {

    private static final Logger LOG = Logger.getInstance(HtmlLoader.class);
    private final Class<?> resourceClass;

    public HtmlLoader(Class<?> resourceClass) {
        this.resourceClass = resourceClass;
    }

    /**
     * Load the chat interface HTML.
     * @return the HTML content, or fallback HTML if loading fails
     */
    public String loadChatHtml() {
        try {
            InputStream is = resourceClass.getResourceAsStream("/html/claude-chat.html");
            if (is != null) {
                String html = new String(is.readAllBytes(), StandardCharsets.UTF_8);
                is.close();

                if (html.contains("<!-- LOCAL_LIBRARY_INJECTION_POINT -->")) {
                    html = injectLocalLibraries(html);
                } else {
                    LOG.info("Detected bundled modern frontend assets; no additional library injection needed");
                }

                // Inject the IDE theme into the HTML to prevent flash of unstyled content on initial load
                html = injectIdeTheme(html);

                return html;
            }
        } catch (Exception e) {
            LOG.error("Failed to load claude-chat.html: " + e.getMessage());
        }

        return generateFallbackHtml();
    }

    /**
     * Inject the IDE theme into the HTML.
     *
     * Strategy: add inline style attributes directly on HTML tags to ensure the background
     * color is applied on the very first render frame.
     * 1. Modify the &lt;html&gt; tag to add style="background-color:..."
     * 2. Modify the &lt;body&gt; tag to add style="background-color:..."
     * 3. Inject a theme variable script into &lt;head&gt;
     *
     * Inline styles are parsed faster than CSS rules, ensuring the correct color appears
     * on the first CEF render frame.
     */
    private String injectIdeTheme(String html) {
        try {
            boolean isDark = ThemeConfigService.getIdeThemeConfig().get("isDark").getAsBoolean();
            String theme = isDark ? "dark" : "light";
            // Use the unified color values to ensure consistency with Swing component backgrounds
            String bgColor = ThemeConfigService.getBackgroundColorHex();

            // 1. Modify the <html> tag to add inline styles
            html = html.replaceFirst(
                "<html([^>]*)>",
                "<html$1 style=\"background-color:" + bgColor + ";\">"
            );

            // 2. Modify the <body> tag to add inline styles
            html = html.replaceFirst(
                "<body([^>]*)>",
                "<body$1 style=\"background-color:" + bgColor + ";\">"
            );

            // 3. Inject a theme variable script after the <head> tag
            String scriptInjection = "\n    <script>window.__INITIAL_IDE_THEME__ = '" + theme + "';</script>";
            int headIndex = html.indexOf("<head>");
            if (headIndex != -1) {
                int insertPos = headIndex + "<head>".length();
                html = html.substring(0, insertPos) + scriptInjection + html.substring(insertPos);
            }

            LOG.info("Successfully injected IDE theme (inline styles): " + theme + ", background: " + bgColor);
        } catch (Exception e) {
            LOG.error("Failed to inject IDE theme: " + e.getMessage(), e);
        }

        return html;
    }

    /**
     * Inject per-tab provider/model into the HTML so the WebView can prefer
     * the backend-restored values over the global localStorage snapshot.
     *
     * Without this, every tab in a multi-tab setup hydrates from the same
     * localStorage key ("model-selection-state") and clobbers the per-tab
     * provider that ClaudeChatWindow.restorePersistedTabSessionState already
     * applied to the session — see issue #1353.
     *
     * Both arguments may be null/empty. Null/empty values are injected as
     * empty strings; the frontend treats an empty string as "no backend
     * preference" and falls back to localStorage. Only non-empty values
     * override the global localStorage snapshot.
     */
    public String injectInitialTabState(String html, String provider, String model) {
        try {
            String safeProvider = escapeForSingleQuotedJs(provider == null ? "" : provider);
            String safeModel = escapeForSingleQuotedJs(model == null ? "" : model);
            String scriptInjection = "\n    <script>"
                    + "window.__INITIAL_TAB_PROVIDER__ = '" + safeProvider + "';"
                    + "window.__INITIAL_TAB_MODEL__ = '" + safeModel + "';"
                    + "</script>";
            int headIndex = html.indexOf("<head>");
            if (headIndex != -1) {
                int insertPos = headIndex + "<head>".length();
                return html.substring(0, insertPos) + scriptInjection + html.substring(insertPos);
            }
        } catch (Exception e) {
            LOG.error("Failed to inject initial tab state: " + e.getMessage(), e);
        }
        return html;
    }

    private static String escapeForSingleQuotedJs(String value) {
        // Restricted set — provider/model IDs only contain safe chars in
        // practice, but a malicious settings.json provider list could carry
        // arbitrary text. Reject the small set that can break out of the
        // single-quoted literal.
        return value
                .replace("\\", "\\\\")
                .replace("'", "\\'")
                .replace("\n", "\\n")
                .replace("\r", "\\r")
                .replace("<", "\\u003c")
                .replace(">", "\\u003e")
                .replace("\u2028", "\\u2028")   // Line separator — string-literal break in pre-ES2019 JS engines
                .replace("\u2029", "\\u2029");  // Paragraph separator — same risk
    }

    /**
     * Generate fallback HTML.
     */
    public String generateFallbackHtml() {
        return "<!DOCTYPE html>" +
            "<html>" +
            "<head>" +
            "<meta charset=\"UTF-8\">" +
            "<title>CC GUI（Claude or Codex）</title>" +
            "<style>" +
            "body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; " +
            "background: #1e1e1e; color: #fff; display: flex; align-items: center; " +
            "justify-content: center; height: 100vh; margin: 0; }" +
            ".error { text-align: center; padding: 40px; }" +
            "h1 { color: #f85149; }" +
            "</style>" +
            "</head>" +
            "<body>" +
            "<div class=\"error\">" +
            "<h1>Failed to load chat interface</h1>" +
            "<p>Please verify that the HTML resource file exists</p>" +
            "</div>" +
            "</body>" +
            "</html>";
    }

    /**
     * Inject local library file contents into the HTML.
     */
    private String injectLocalLibraries(String html) {
        try {
            String reactJs = loadResourceAsString("/libs/react.production.min.js");
            String reactDomJs = loadResourceAsString("/libs/react-dom.production.min.js");
            String babelJs = loadResourceAsString("/libs/babel.min.js");
            String markedJs = loadResourceAsString("/libs/marked.min.js");
            String codiconCss = loadResourceAsString("/libs/codicon.css");

            String fontBase64 = loadResourceAsBase64("/libs/codicon.ttf");
            codiconCss = codiconCss.replaceAll(
                "url\\(\"\\./codicon\\.ttf\\?[^\"]*\"\\)",
                "url(\"data:font/truetype;base64," + fontBase64 + "\")"
            );

            StringBuilder injectedLibs = new StringBuilder();
            injectedLibs.append("\n    <!-- React and related libraries (local versions) -->\n");
            injectedLibs.append("    <script>/* React 18 */\n").append(reactJs).append("\n    </script>\n");
            injectedLibs.append("    <script>/* ReactDOM 18 */\n").append(reactDomJs).append("\n    </script>\n");
            injectedLibs.append("    <script>/* Babel Standalone */\n").append(babelJs).append("\n    </script>\n");
            injectedLibs.append("    <script>/* Marked */\n").append(markedJs).append("\n    </script>\n");
            injectedLibs.append("    <style>/* VS Code Codicons (with embedded font) */\n").append(codiconCss).append("\n    </style>");

            html = html.replace("<!-- LOCAL_LIBRARY_INJECTION_POINT -->", injectedLibs.toString());

            LOG.info("Successfully injected local libraries (React + ReactDOM + Babel + Codicons)");
        } catch (Exception e) {
            LOG.error("Failed to inject local libraries: " + e.getMessage());
        }

        return html;
    }

    /**
     * Load a resource file as a string.
     */
    private String loadResourceAsString(String resourcePath) throws Exception {
        InputStream is = resourceClass.getResourceAsStream(resourcePath);
        if (is == null) {
            throw new Exception("Resource not found: " + resourcePath);
        }
        String content = new String(is.readAllBytes(), StandardCharsets.UTF_8);
        is.close();
        return content;
    }

    /**
     * Load a resource file as a Base64-encoded string.
     */
    private String loadResourceAsBase64(String resourcePath) throws Exception {
        InputStream is = resourceClass.getResourceAsStream(resourcePath);
        if (is == null) {
            throw new Exception("Resource not found: " + resourcePath);
        }
        byte[] bytes = is.readAllBytes();
        is.close();
        return Base64.getEncoder().encodeToString(bytes);
    }
}
