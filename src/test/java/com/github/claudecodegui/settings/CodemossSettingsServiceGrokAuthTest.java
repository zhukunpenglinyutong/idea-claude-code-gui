package com.github.claudecodegui.settings;

import com.github.claudecodegui.util.PlatformUtils;
import org.junit.After;
import org.junit.Test;

import java.lang.reflect.Field;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.Assert.assertEquals;

/**
 * Pins the Grok auth-method normalization matrix and the auth-config persistence
 * round-trip backing the {@code get_grok_auth_config}/{@code set_grok_auth_config}
 * bridge + Settings UI (Grok provider runtime + auth settings PR).
 *
 * <p>Normalization is the non-trivial part: the raw value arriving from the webview
 * (or legacy config) can be any of {@code api_key}/{@code xai.api_key}/{@code apikey},
 * {@code oauth}/{@code cached_token}/{@code cli_login}/{@code grok.com}, or
 * {@code auto}, in arbitrary case — all must collapse to the canonical tri-state the
 * {@code GrokSDKBridge} environment wiring switches on. The round-trip proves the
 * settings survive a fresh service instance (i.e. a real write→read through the
 * config file), so a saved Grok API key still authenticates the next session.
 */
public class CodemossSettingsServiceGrokAuthTest {
    private String originalHomeDir;

    @After
    public void tearDown() throws Exception {
        if (originalHomeDir != null) {
            setCachedHomeDirectory(originalHomeDir);
            originalHomeDir = null;
        }
    }

    // -- normalizeGrokAuthMethod ------------------------------------------------

    @Test
    public void normalizeDefaultsToOauthForBlankInput() {
        assertEquals(CodemossSettingsService.DEFAULT_GROK_AUTH_METHOD,
                CodemossSettingsService.normalizeGrokAuthMethod(null));
        assertEquals(CodemossSettingsService.DEFAULT_GROK_AUTH_METHOD,
                CodemossSettingsService.normalizeGrokAuthMethod(""));
        assertEquals(CodemossSettingsService.DEFAULT_GROK_AUTH_METHOD,
                CodemossSettingsService.normalizeGrokAuthMethod("   "));
    }

    @Test
    public void normalizeMapsApiKeyAliases() {
        // The webview may send any of these for the API-key auth method.
        assertEquals(CodemossSettingsService.GROK_AUTH_METHOD_API_KEY,
                CodemossSettingsService.normalizeGrokAuthMethod("api_key"));
        assertEquals(CodemossSettingsService.GROK_AUTH_METHOD_API_KEY,
                CodemossSettingsService.normalizeGrokAuthMethod("xai.api_key"));
        assertEquals(CodemossSettingsService.GROK_AUTH_METHOD_API_KEY,
                CodemossSettingsService.normalizeGrokAuthMethod("apikey"));
    }

    @Test
    public void normalizeIsCaseInsensitive() {
        assertEquals(CodemossSettingsService.GROK_AUTH_METHOD_API_KEY,
                CodemossSettingsService.normalizeGrokAuthMethod("API_KEY"));
        assertEquals(CodemossSettingsService.GROK_AUTH_METHOD_API_KEY,
                CodemossSettingsService.normalizeGrokAuthMethod("XAI.API_KEY"));
        assertEquals(CodemossSettingsService.GROK_AUTH_METHOD_OAUTH,
                CodemossSettingsService.normalizeGrokAuthMethod("OAUTH"));
        assertEquals(CodemossSettingsService.GROK_AUTH_METHOD_AUTO,
                CodemossSettingsService.normalizeGrokAuthMethod("AUTO"));
    }

    @Test
    public void normalizeMapsOauthAliases() {
        // cached_token / cli_login / grok.com are all oauth-style flows the CLI
        // surfaces under different names — they must select the oauth env wiring.
        assertEquals(CodemossSettingsService.GROK_AUTH_METHOD_OAUTH,
                CodemossSettingsService.normalizeGrokAuthMethod("oauth"));
        assertEquals(CodemossSettingsService.GROK_AUTH_METHOD_OAUTH,
                CodemossSettingsService.normalizeGrokAuthMethod("cached_token"));
        assertEquals(CodemossSettingsService.GROK_AUTH_METHOD_OAUTH,
                CodemossSettingsService.normalizeGrokAuthMethod("cli_login"));
        assertEquals(CodemossSettingsService.GROK_AUTH_METHOD_OAUTH,
                CodemossSettingsService.normalizeGrokAuthMethod("grok.com"));
    }

    @Test
    public void normalizeAcceptsAuto() {
        assertEquals(CodemossSettingsService.GROK_AUTH_METHOD_AUTO,
                CodemossSettingsService.normalizeGrokAuthMethod("auto"));
    }

    @Test
    public void normalizeFallsBackToDefaultForUnknown() {
        assertEquals(CodemossSettingsService.DEFAULT_GROK_AUTH_METHOD,
                CodemossSettingsService.normalizeGrokAuthMethod("garbage"));
        assertEquals(CodemossSettingsService.DEFAULT_GROK_AUTH_METHOD,
                CodemossSettingsService.normalizeGrokAuthMethod("password"));
    }

    // -- persistence round-trip -------------------------------------------------

    @Test
    public void authMethodDefaultsToOauthOnAFreshConfig() throws Exception {
        Path tempHome = Files.createTempDirectory("grok-auth-default-home");
        useTemporaryHomeDirectory(tempHome);

        CodemossSettingsService service = new CodemossSettingsService();
        assertEquals(CodemossSettingsService.DEFAULT_GROK_AUTH_METHOD, service.getGrokAuthMethod());
    }

    @Test
    public void grokAuthConfigRoundTripsThroughTheConfigFile() throws Exception {
        // Set on one instance, read back on a fresh one — proves a real write→read
        // so a saved key/base URL still authenticates and routes the next session.
        Path tempHome = Files.createTempDirectory("grok-auth-roundtrip-home");
        useTemporaryHomeDirectory(tempHome);

        CodemossSettingsService writer = new CodemossSettingsService();
        writer.setGrokAuthMethod("xai.api_key"); // alias → normalized to api_key on store
        writer.setGrokApiKey("xai-secret-key");
        writer.setGrokApiBaseUrl("https://api.x.ai");
        writer.setGrokOauthBaseUrl("https://oauth.x.ai");

        CodemossSettingsService reader = new CodemossSettingsService();
        assertEquals(CodemossSettingsService.GROK_AUTH_METHOD_API_KEY, reader.getGrokAuthMethod());
        assertEquals("xai-secret-key", reader.getGrokApiKey());
        assertEquals("https://api.x.ai", reader.getGrokApiBaseUrl());
        assertEquals("https://oauth.x.ai", reader.getGrokOauthBaseUrl());
    }

    @Test
    public void emptyApiKeyRemovesTheEntry() throws Exception {
        Path tempHome = Files.createTempDirectory("grok-auth-empty-key-home");
        useTemporaryHomeDirectory(tempHome);

        CodemossSettingsService writer = new CodemossSettingsService();
        writer.setGrokApiKey("then-removed");
        writer.setGrokApiKey(""); // empty → entry removed, get returns ""

        CodemossSettingsService reader = new CodemossSettingsService();
        assertEquals("", reader.getGrokApiKey());
    }

    // -- temp-home isolation (mirrors CodemossSettingsServiceCodexCliLoginTest) --

    private void useTemporaryHomeDirectory(Path tempHome) throws Exception {
        if (originalHomeDir == null) {
            originalHomeDir = getCachedHomeDirectory();
        }
        setCachedHomeDirectory(tempHome.toString());
    }

    private String getCachedHomeDirectory() throws Exception {
        Field field = PlatformUtils.class.getDeclaredField("cachedRealHomeDir");
        field.setAccessible(true);
        return (String) field.get(null);
    }

    private void setCachedHomeDirectory(String homeDir) throws Exception {
        Field field = PlatformUtils.class.getDeclaredField("cachedRealHomeDir");
        field.setAccessible(true);
        field.set(null, homeDir);
    }
}
