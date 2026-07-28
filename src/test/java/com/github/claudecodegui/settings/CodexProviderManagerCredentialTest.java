package com.github.claudecodegui.settings;

import com.github.claudecodegui.model.DeleteResult;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import org.junit.Test;

import java.io.IOException;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Consumer;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

public class CodexProviderManagerCredentialTest {

    @Test
    public void newCredentialIsStoredOutsideConfigAndHydratedOnRead() throws Exception {
        AtomicReference<JsonObject> config = new AtomicReference<>(configWithProvider());
        FakeCredentialStore credentials = new FakeCredentialStore();
        CodexProviderManager manager = manager(config, credentials);
        JsonObject provider = provider("provider-secret");
        provider.addProperty("authJson", "{\"OPENAI_API_KEY\":\"secret\"}");

        manager.addCodexProvider(provider);

        JsonObject persisted = config.get().getAsJsonObject("codex").getAsJsonObject("providers")
                .getAsJsonObject("provider-secret");
        assertFalse(persisted.has("authJson"));
        assertTrue(persisted.get("authStoredInPasswordSafe").getAsBoolean());
        JsonObject hydrated = manager.getCodexProviders().stream()
                .filter(candidate -> "provider-secret".equals(candidate.get("id").getAsString()))
                .findFirst()
                .orElseThrow();
        assertEquals("{\"OPENAI_API_KEY\":\"secret\"}", hydrated.get("authJson").getAsString());
    }

    @Test
    public void passwordSafeWriteFailureNeverPersistsPlaintextCredential() {
        AtomicReference<JsonObject> config = new AtomicReference<>(configWithProvider());
        FakeCredentialStore credentials = new FakeCredentialStore();
        credentials.failWrites = true;
        CodexProviderManager manager = manager(config, credentials);
        JsonObject provider = provider("provider-secret");
        provider.addProperty("authJson", "{\"OPENAI_API_KEY\":\"secret\"}");

        assertThrows(IllegalStateException.class, () -> manager.addCodexProvider(provider));
        assertFalse(config.get().getAsJsonObject("codex").getAsJsonObject("providers")
                .has("provider-secret"));
        assertFalse(config.get().toString().contains("secret"));
    }

    @Test
    public void configWriteFailureRestoresPreviousCredential() {
        AtomicReference<JsonObject> config = new AtomicReference<>(configWithProvider());
        JsonObject stored = config.get().getAsJsonObject("codex").getAsJsonObject("providers")
                .getAsJsonObject("provider-a");
        stored.addProperty("authStoredInPasswordSafe", true);
        FakeCredentialStore credentials = new FakeCredentialStore();
        credentials.values.put("provider-a", "{\"OPENAI_API_KEY\":\"old\"}");
        CodexProviderManager manager = manager(config, ignored -> {
            throw new IllegalStateException("config write failed");
        }, credentials);
        JsonObject updates = new JsonObject();
        updates.addProperty("authJson", "{\"OPENAI_API_KEY\":\"new\"}");

        assertThrows(IllegalStateException.class,
                () -> manager.updateCodexProvider("provider-a", updates));
        assertEquals("{\"OPENAI_API_KEY\":\"old\"}", credentials.read("provider-a"));
    }

    @Test
    public void passwordSafeDeleteFailurePreservesStoredCredentialMarker() {
        AtomicReference<JsonObject> config = new AtomicReference<>(configWithProvider());
        JsonObject stored = config.get().getAsJsonObject("codex").getAsJsonObject("providers")
                .getAsJsonObject("provider-a");
        stored.addProperty("authStoredInPasswordSafe", true);
        FakeCredentialStore credentials = new FakeCredentialStore();
        credentials.values.put("provider-a", "{\"OPENAI_API_KEY\":\"old\"}");
        credentials.failDeletes = true;
        CodexProviderManager manager = manager(config, credentials);
        JsonObject updates = new JsonObject();
        updates.addProperty("authJson", "");

        assertThrows(IllegalStateException.class,
                () -> manager.updateCodexProvider("provider-a", updates));
        assertTrue(config.get().getAsJsonObject("codex").getAsJsonObject("providers")
                .getAsJsonObject("provider-a").get("authStoredInPasswordSafe").getAsBoolean());
    }

    @Test
    public void providerDeletionStopsWhenPasswordSafeCredentialCannotBeRemoved() {
        AtomicReference<JsonObject> config = new AtomicReference<>(configWithProvider());
        JsonObject stored = config.get().getAsJsonObject("codex").getAsJsonObject("providers")
                .getAsJsonObject("provider-a");
        stored.addProperty("authStoredInPasswordSafe", true);
        FakeCredentialStore credentials = new FakeCredentialStore();
        credentials.values.put("provider-a", "{\"OPENAI_API_KEY\":\"old\"}");
        credentials.failDeletes = true;

        DeleteResult result = manager(config, credentials).deleteCodexProvider("provider-a");

        assertFalse(result.isSuccess());
        assertTrue(config.get().getAsJsonObject("codex").getAsJsonObject("providers")
                .has("provider-a"));
        assertEquals("{\"OPENAI_API_KEY\":\"old\"}", credentials.read("provider-a"));
    }

    @Test
    public void legacyAuthJsonIsMigratedOnlyAfterPasswordSafeVerification() {
        AtomicReference<JsonObject> config = new AtomicReference<>(configWithProvider());
        JsonObject stored = config.get().getAsJsonObject("codex").getAsJsonObject("providers")
                .getAsJsonObject("provider-a");
        stored.addProperty("authJson", "{\"OPENAI_API_KEY\":\"secret\"}");
        FakeCredentialStore credentials = new FakeCredentialStore();
        CodexProviderManager manager = manager(config, credentials);

        JsonObject returned = manager.getCodexProviders().get(1);
        JsonObject persisted = config.get().getAsJsonObject("codex").getAsJsonObject("providers")
                .getAsJsonObject("provider-a");
        assertEquals("{\"OPENAI_API_KEY\":\"secret\"}", returned.get("authJson").getAsString());
        assertTrue(persisted.get("authStoredInPasswordSafe").getAsBoolean());
        assertFalse(persisted.has("authJson"));
    }

    @Test
    public void unavailablePasswordSafeCredentialBlocksProviderApply() {
        AtomicReference<JsonObject> config = new AtomicReference<>(configWithProvider());
        JsonObject stored = config.get().getAsJsonObject("codex").getAsJsonObject("providers")
                .getAsJsonObject("provider-a");
        stored.addProperty("authStoredInPasswordSafe", true);

        CodexProviderManager manager = manager(config, new FakeCredentialStore());

        assertThrows(IOException.class, manager::applyActiveProviderToCodexSettings);
    }

    private CodexProviderManager manager(AtomicReference<JsonObject> config,
                                         CodexProviderCredentialStore credentials) {
        return manager(config, config::set, credentials);
    }

    private CodexProviderManager manager(AtomicReference<JsonObject> config,
                                         Consumer<JsonObject> configWriter,
                                         CodexProviderCredentialStore credentials) {
        Gson gson = new Gson();
        return new CodexProviderManager(gson, ignored -> config.get().deepCopy(), configWriter,
                new ConfigPathManager(), new CodexSettingsManager(gson), credentials);
    }

    private JsonObject configWithProvider() {
        JsonObject provider = new JsonObject();
        provider.addProperty("name", "Provider A");
        JsonObject providers = new JsonObject();
        providers.add("provider-a", provider);
        JsonObject codex = new JsonObject();
        codex.addProperty("current", "provider-a");
        codex.add("providers", providers);
        JsonObject config = new JsonObject();
        config.add("codex", codex);
        return config;
    }

    private JsonObject provider(String id) {
        JsonObject provider = new JsonObject();
        provider.addProperty("id", id);
        provider.addProperty("name", "Provider");
        return provider;
    }

    private static final class FakeCredentialStore extends CodexProviderCredentialStore {
        private final Map<String, String> values = new HashMap<>();
        private boolean failWrites;
        private boolean failDeletes;

        @Override
        public boolean isPersistentStorageAvailable() {
            return true;
        }

        @Override
        public boolean writeVerified(String providerId, String authJson) {
            if (failWrites) {
                return false;
            }
            values.put(providerId, authJson);
            return authJson.equals(read(providerId));
        }

        @Override
        public String read(String providerId) {
            return values.get(providerId);
        }

        @Override
        public void delete(String providerId) {
            if (!failDeletes) {
                values.remove(providerId);
            }
        }

        @Override
        public boolean deleteVerified(String providerId) {
            if (failDeletes) {
                return false;
            }
            values.remove(providerId);
            return true;
        }
    }
}
