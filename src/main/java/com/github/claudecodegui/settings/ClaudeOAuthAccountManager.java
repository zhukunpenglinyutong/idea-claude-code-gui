package com.github.claudecodegui.settings;

import com.github.claudecodegui.bridge.NodeDetector;
import com.github.claudecodegui.util.PlatformUtils;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.intellij.credentialStore.CredentialAttributes;
import com.intellij.credentialStore.Credentials;
import com.intellij.ide.passwordSafe.PasswordSafe;
import com.intellij.openapi.diagnostic.Logger;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardCopyOption;
import java.nio.file.attribute.PosixFilePermission;
import java.util.ArrayList;
import java.util.EnumSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.function.Consumer;
import java.util.function.Function;

/**
 * Stores multiple Claude CLI OAuth accounts.
 *
 * <p>Account metadata is kept in {@code ~/.codemoss/config.json}; OAuth credentials
 * and the matching {@code oauthAccount} payload are kept in JetBrains PasswordSafe.
 * Switching accounts updates only Claude Code's live credential store and account
 * metadata, so projects, history, settings, commands, and skills remain shared.</p>
 */
public class ClaudeOAuthAccountManager {
    private static final Logger LOG = Logger.getInstance(ClaudeOAuthAccountManager.class);
    private static final String ACCOUNTS_KEY = "oauthAccounts";
    private static final String PASSWORD_SAFE_SERVICE_PREFIX = "ClaudeCodeGUI OAuth account ";
    private static final String CHUNK_MARKER_PREFIX = "chunks:";
    // Keep well below Windows Credential Manager's 2560-byte blob limit even
    // when a chunk contains multi-byte UTF-8 account metadata.
    private static final int PASSWORD_SAFE_CHUNK_SIZE = 512;
    public static final String ACCOUNT_ID_PREFIX = "__cli_account__:";
    // macOS Keychain entry the bundled claude-agent-sdk reads/writes. The SDK uses the
    // suffix-less service name when the default config dir is active (no CLAUDE_CONFIG_DIR),
    // which is how ai-bridge spawns it. Account label mirrors the SDK's $USER selection.
    private static final String MAC_KEYCHAIN_SERVICE = "Claude Code-credentials";
    private static final java.util.regex.Pattern KEYCHAIN_ACCOUNT_PATTERN =
            java.util.regex.Pattern.compile("[a-zA-Z0-9._-]+");

    private final Gson gson;
    private final Function<Void, JsonObject> configReader;
    private final Consumer<JsonObject> configWriter;

    public ClaudeOAuthAccountManager(
            Gson gson,
            Function<Void, JsonObject> configReader,
            Consumer<JsonObject> configWriter
    ) {
        this.gson = gson;
        this.configReader = configReader;
        this.configWriter = configWriter;
    }

    public boolean isAccountId(String id) {
        return id != null && id.startsWith(ACCOUNT_ID_PREFIX);
    }

    public List<JsonObject> getAccounts(String currentId) {
        JsonObject accounts = getAccountsObject(configReader.apply(null), false);
        List<JsonObject> result = new ArrayList<>();
        if (accounts == null) {
            return result;
        }

        for (String id : accounts.keySet()) {
            if (!accounts.get(id).isJsonObject()) {
                continue;
            }
            JsonObject account = accounts.getAsJsonObject(id).deepCopy();
            account.addProperty("id", id);
            account.addProperty("isActive", id.equals(currentId));
            account.addProperty("isCliAccountProvider", true);
            account.addProperty("isAuthenticated", readStoredPayload(id) != null);
            result.add(account);
        }
        return result;
    }

    public JsonObject getAccount(String id, boolean isActive) {
        JsonObject accounts = getAccountsObject(configReader.apply(null), false);
        if (accounts == null || !accounts.has(id) || !accounts.get(id).isJsonObject()) {
            return null;
        }
        JsonObject account = accounts.getAsJsonObject(id).deepCopy();
        account.addProperty("id", id);
        account.addProperty("isActive", isActive);
        account.addProperty("isCliAccountProvider", true);
        account.addProperty("isAuthenticated", readStoredPayload(id) != null);
        return account;
    }

    /**
     * Capture the account currently logged in through Claude CLI.
     * Existing entries with the same email are refreshed in place.
     */
    public JsonObject saveCurrentAccount() throws IOException {
        String credentials = readLiveCredentials();
        if (credentials == null || credentials.isBlank()) {
            throw new IOException("Claude CLI is not logged in. Run 'claude auth login' first.");
        }
        validateCredentialJson(credentials);

        JsonObject oauthAccount = readLiveOauthAccount();
        String email = getString(oauthAccount, "emailAddress");
        if (email == null || email.isBlank()) {
            throw new IOException("Claude CLI account email is unavailable");
        }

        JsonObject config = configReader.apply(null);
        JsonObject accounts = getAccountsObject(config, true);
        String existingId = findAccountIdByEmail(accounts, email);
        String id = existingId != null ? existingId : ACCOUNT_ID_PREFIX + UUID.randomUUID();

        JsonObject metadata = existingId != null
                ? accounts.getAsJsonObject(existingId)
                : new JsonObject();
        metadata.addProperty("name", displayName(oauthAccount, email));
        metadata.addProperty("emailAddress", email);
        if (!metadata.has("createdAt")) {
            metadata.addProperty("createdAt", System.currentTimeMillis());
        }
        metadata.addProperty("updatedAt", System.currentTimeMillis());
        accounts.add(id, metadata);
        ensureClaudeSection(config).addProperty("current", id);

        JsonObject payload = new JsonObject();
        payload.addProperty("credentials", credentials);
        payload.add("oauthAccount", oauthAccount.deepCopy());
        writeStoredPayload(id, payload);
        configWriter.accept(config);

        return getAccount(id, false);
    }

    public void switchToAccount(String id) throws IOException {
        if (!isAccountId(id)) {
            throw new IllegalArgumentException("Invalid Claude OAuth account id");
        }
        JsonObject account = getAccount(id, false);
        if (account == null) {
            throw new IllegalArgumentException("Claude OAuth account not found");
        }

        JsonObject payload = readStoredPayload(id);
        if (payload == null || !payload.has("credentials")) {
            throw new IOException("Stored OAuth credentials are unavailable for this account");
        }

        String credentials = payload.get("credentials").getAsString();
        validateCredentialJson(credentials);
        String previousCredentials = readLiveCredentials();
        JsonObject previousOauthAccount = readLiveOauthAccountOrNull();
        try {
            writeLiveCredentials(credentials);
            if (payload.has("oauthAccount") && payload.get("oauthAccount").isJsonObject()) {
                writeLiveOauthAccount(payload.getAsJsonObject("oauthAccount"));
            }

            JsonObject config = configReader.apply(null);
            JsonObject claude = ensureClaudeSection(config);
            claude.addProperty("current", id);
            configWriter.accept(config);
        } catch (Exception switchError) {
            rollbackLiveAccount(previousCredentials, previousOauthAccount);
            if (switchError instanceof IOException) {
                throw (IOException) switchError;
            }
            throw new IOException("Failed to switch Claude OAuth account", switchError);
        }
        LOG.info("[ClaudeOAuthAccounts] Switched active account to: " + id);
    }

    /**
     * Persist fresh live credentials before leaving a managed account. Claude Code
     * may rotate access/refresh tokens while the account is active.
     */
    public void refreshActiveAccountIfNeeded() {
        try {
            JsonObject config = configReader.apply(null);
            if (!config.has("claude") || !config.get("claude").isJsonObject()) {
                return;
            }
            JsonObject claude = config.getAsJsonObject("claude");
            String currentId = claude.has("current") && !claude.get("current").isJsonNull()
                    ? claude.get("current").getAsString()
                    : "";
            if (isAccountId(currentId)) {
                saveCurrentAccount();
            }
        } catch (Exception e) {
            LOG.warn("[ClaudeOAuthAccounts] Failed to refresh active account snapshot: " + e.getMessage());
        }
    }

    public void deleteAccount(String id) throws IOException {
        JsonObject config = configReader.apply(null);
        JsonObject claude = ensureClaudeSection(config);
        JsonObject accounts = getAccountsObject(config, false);
        if (accounts == null || !accounts.has(id)) {
            throw new IllegalArgumentException("Claude OAuth account not found");
        }

        boolean wasActive = claude.has("current") && id.equals(claude.get("current").getAsString());
        accounts.remove(id);
        if (wasActive) {
            claude.addProperty("current", "");
        }
        configWriter.accept(config);
        if (wasActive) {
            clearLiveCredentials();
            removeLiveOauthAccount();
        }
        deleteStoredPayload(id);
        LOG.info("[ClaudeOAuthAccounts] Deleted account: " + id);
    }

    private JsonObject readStoredPayload(String id) {
        try {
            Credentials credentials = PasswordSafe.getInstance().get(credentialAttributes(id));
            if (credentials == null || credentials.getPasswordAsString() == null) {
                return null;
            }
            String stored = credentials.getPasswordAsString();
            if (stored.startsWith(CHUNK_MARKER_PREFIX)) {
                ChunkMarker marker = parseChunkMarker(stored);
                StringBuilder combined = new StringBuilder(marker.count * PASSWORD_SAFE_CHUNK_SIZE);
                for (int i = 0; i < marker.count; i++) {
                    Credentials chunk = PasswordSafe.getInstance().get(
                            chunkAttributes(id, marker.generation, i));
                    if (chunk == null || chunk.getPasswordAsString() == null) {
                        return null;
                    }
                    combined.append(chunk.getPasswordAsString());
                }
                stored = combined.toString();
            }
            return JsonParser.parseString(stored).getAsJsonObject();
        } catch (Exception e) {
            LOG.warn("[ClaudeOAuthAccounts] Failed to read PasswordSafe entry for " + id + ": " + e.getMessage());
            return null;
        }
    }

    private void writeStoredPayload(String id, JsonObject payload) {
        String serialized = gson.toJson(payload);
        int chunkCount = (serialized.length() + PASSWORD_SAFE_CHUNK_SIZE - 1) / PASSWORD_SAFE_CHUNK_SIZE;
        String generation = UUID.randomUUID().toString();
        Credentials previousMarker = PasswordSafe.getInstance().get(credentialAttributes(id));
        for (int i = 0; i < chunkCount; i++) {
            int start = i * PASSWORD_SAFE_CHUNK_SIZE;
            int end = Math.min(serialized.length(), start + PASSWORD_SAFE_CHUNK_SIZE);
            PasswordSafe.getInstance().set(
                    chunkAttributes(id, generation, i),
                    new Credentials(id, serialized.substring(start, end))
            );
        }
        PasswordSafe.getInstance().set(
                credentialAttributes(id),
                new Credentials(id, CHUNK_MARKER_PREFIX + generation + ":" + chunkCount)
        );
        deleteChunksFromMarker(id, previousMarker);
    }

    private CredentialAttributes credentialAttributes(String id) {
        return new CredentialAttributes(PASSWORD_SAFE_SERVICE_PREFIX + id, id);
    }

    private CredentialAttributes chunkAttributes(String id, String generation, int index) {
        String generationSuffix = generation == null ? "" : generation + " ";
        return new CredentialAttributes(
                PASSWORD_SAFE_SERVICE_PREFIX + id + " chunk " + generationSuffix + index,
                id
        );
    }

    private void deleteStoredPayload(String id) {
        try {
            Credentials marker = PasswordSafe.getInstance().get(credentialAttributes(id));
            deleteChunksFromMarker(id, marker);
        } catch (Exception e) {
            LOG.warn("[ClaudeOAuthAccounts] Failed to clean old credential chunks: " + e.getMessage());
        }
        PasswordSafe.getInstance().set(credentialAttributes(id), null);
    }

    private void deleteChunksFromMarker(String id, Credentials credentials) {
        if (credentials == null || credentials.getPasswordAsString() == null
                || !credentials.getPasswordAsString().startsWith(CHUNK_MARKER_PREFIX)) {
            return;
        }
        ChunkMarker marker = parseChunkMarker(credentials.getPasswordAsString());
        for (int i = 0; i < marker.count; i++) {
            PasswordSafe.getInstance().set(chunkAttributes(id, marker.generation, i), null);
        }
    }

    private ChunkMarker parseChunkMarker(String value) {
        String markerValue = value.substring(CHUNK_MARKER_PREFIX.length());
        int separator = markerValue.lastIndexOf(':');
        if (separator < 0) {
            return new ChunkMarker(null, Integer.parseInt(markerValue));
        }
        String generation = markerValue.substring(0, separator);
        int count = Integer.parseInt(markerValue.substring(separator + 1));
        return new ChunkMarker(generation, count);
    }

    private String readLiveCredentials() throws IOException {
        if (PlatformUtils.isMac()) {
            // Match exactly what the bundled claude-agent-sdk reads: service
            // "Claude Code-credentials", account = $USER (see macKeychainAccount).
            // Reading without -a returns an arbitrary item when several accounts
            // share the service, which can surface the wrong credential.
            Process process = new ProcessBuilder(
                    "/usr/bin/security",
                    "find-generic-password",
                    "-a", macKeychainAccount(),
                    "-s", MAC_KEYCHAIN_SERVICE,
                    "-w"
            ).redirectErrorStream(true).start();
            String output = new String(process.getInputStream().readAllBytes(), StandardCharsets.UTF_8).trim();
            try {
                if (process.waitFor() != 0) {
                    return "";
                }
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new IOException("Interrupted while reading macOS Keychain", e);
            }
            return output;
        }

        Path credentialsPath = getLiveCredentialsPath();
        return Files.exists(credentialsPath)
                ? Files.readString(credentialsPath, StandardCharsets.UTF_8)
                : "";
    }

    private void writeLiveCredentials(String credentials) throws IOException {
        if (PlatformUtils.isMac()) {
            // `security add-generic-password -w` does NOT read the secret from stdin:
            // with no value it prompts on the TTY, so a headless process silently
            // stores an EMPTY secret (verified). Pass the secret as the -w argument so
            // it is actually written. It is briefly visible to local `ps`, which is an
            // acceptable trade-off for a credential that already lives in this keychain.
            Process process = new ProcessBuilder(
                    "/usr/bin/security",
                    "add-generic-password",
                    "-U",
                    "-s", MAC_KEYCHAIN_SERVICE,
                    "-a", macKeychainAccount(),
                    "-w", credentials
            ).redirectErrorStream(true).start();
            String output = new String(process.getInputStream().readAllBytes(), StandardCharsets.UTF_8).trim();
            try {
                if (process.waitFor() != 0) {
                    throw new IOException("Failed to update macOS Keychain: " + output);
                }
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new IOException("Interrupted while updating macOS Keychain", e);
            }
            return;
        }

        Path target = getLiveCredentialsPath();
        Files.createDirectories(target.getParent());
        writeAtomically(target, credentials);
        setOwnerOnlyPermissions(target);
    }

    private JsonObject readLiveOauthAccount() throws IOException {
        Path configPath = getGlobalClaudeConfigPath();
        if (!Files.exists(configPath)) {
            throw new IOException("Claude CLI global config not found: " + configPath);
        }
        JsonObject root = JsonParser.parseString(Files.readString(configPath, StandardCharsets.UTF_8))
                .getAsJsonObject();
        if (!root.has("oauthAccount") || !root.get("oauthAccount").isJsonObject()) {
            throw new IOException("Claude CLI OAuth account metadata is unavailable");
        }
        return root.getAsJsonObject("oauthAccount");
    }

    private JsonObject readLiveOauthAccountOrNull() {
        try {
            return readLiveOauthAccount().deepCopy();
        } catch (Exception ignored) {
            return null;
        }
    }

    private void writeLiveOauthAccount(JsonObject oauthAccount) throws IOException {
        Path configPath = getGlobalClaudeConfigPath();
        JsonObject root = Files.exists(configPath)
                ? JsonParser.parseString(Files.readString(configPath, StandardCharsets.UTF_8)).getAsJsonObject()
                : new JsonObject();
        root.add("oauthAccount", oauthAccount.deepCopy());
        writeAtomically(configPath, gson.toJson(root));
        setOwnerOnlyPermissions(configPath);
    }

    private void removeLiveOauthAccount() throws IOException {
        Path configPath = getGlobalClaudeConfigPath();
        if (!Files.exists(configPath)) {
            return;
        }
        JsonObject root = JsonParser.parseString(Files.readString(configPath, StandardCharsets.UTF_8))
                .getAsJsonObject();
        root.remove("oauthAccount");
        writeAtomically(configPath, gson.toJson(root));
        setOwnerOnlyPermissions(configPath);
    }

    private void clearLiveCredentials() throws IOException {
        if (PlatformUtils.isMac()) {
            Process process = new ProcessBuilder(
                    "/usr/bin/security",
                    "delete-generic-password",
                    "-a", macKeychainAccount(),
                    "-s", MAC_KEYCHAIN_SERVICE
            ).redirectErrorStream(true).start();
            try {
                int exitCode = process.waitFor();
                if (exitCode != 0 && exitCode != 44) {
                    String output = new String(process.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
                    throw new IOException("Failed to clear macOS Keychain: " + output.trim());
                }
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new IOException("Interrupted while clearing macOS Keychain", e);
            }
            return;
        }
        Files.deleteIfExists(getLiveCredentialsPath());
    }

    private void rollbackLiveAccount(String credentials, JsonObject oauthAccount) {
        try {
            if (credentials == null || credentials.isBlank()) {
                clearLiveCredentials();
            } else {
                writeLiveCredentials(credentials);
            }
            if (oauthAccount == null) {
                removeLiveOauthAccount();
            } else {
                writeLiveOauthAccount(oauthAccount);
            }
        } catch (Exception rollbackError) {
            LOG.error("[ClaudeOAuthAccounts] Failed to roll back partial account switch", rollbackError);
        }
    }

    /**
     * Mirror the bundled SDK's keychain account selection (f0): prefer $USER, fall back to
     * the JVM login name, and use "claude-code-user" if neither is a safe label.
     */
    private String macKeychainAccount() {
        String user = System.getenv("USER");
        if (user == null || !KEYCHAIN_ACCOUNT_PATTERN.matcher(user).matches()) {
            user = System.getProperty("user.name");
        }
        return (user != null && KEYCHAIN_ACCOUNT_PATTERN.matcher(user).matches())
                ? user
                : "claude-code-user";
    }

    private Path getLiveCredentialsPath() {
        return Paths.get(NodeDetector.resolveHomeForFileOps(), ".claude", ".credentials.json");
    }

    private Path getGlobalClaudeConfigPath() {
        return Paths.get(NodeDetector.resolveHomeForFileOps(), ".claude.json");
    }

    private void writeAtomically(Path target, String content) throws IOException {
        Path parent = target.getParent();
        if (parent != null) {
            Files.createDirectories(parent);
        }
        Path temp = Files.createTempFile(parent, target.getFileName().toString(), ".tmp");
        try {
            Files.writeString(temp, content, StandardCharsets.UTF_8);
            try {
                Files.move(temp, target, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
            } catch (AtomicMoveNotSupportedException ignored) {
                Files.move(temp, target, StandardCopyOption.REPLACE_EXISTING);
            }
        } finally {
            Files.deleteIfExists(temp);
        }
    }

    private void setOwnerOnlyPermissions(Path path) {
        try {
            Set<PosixFilePermission> permissions = EnumSet.of(
                    PosixFilePermission.OWNER_READ,
                    PosixFilePermission.OWNER_WRITE
            );
            Files.setPosixFilePermissions(path, permissions);
        } catch (UnsupportedOperationException | IOException ignored) {
            // Windows and non-POSIX filesystems use their native ACLs.
        }
    }

    private void validateCredentialJson(String credentials) throws IOException {
        try {
            JsonObject root = JsonParser.parseString(credentials).getAsJsonObject();
            if (!root.has("claudeAiOauth") || !root.get("claudeAiOauth").isJsonObject()) {
                throw new IOException("Claude OAuth credential payload is missing");
            }
        } catch (IOException e) {
            throw e;
        } catch (Exception e) {
            throw new IOException("Claude OAuth credential payload is invalid", e);
        }
    }

    private JsonObject getAccountsObject(JsonObject config, boolean create) {
        JsonObject claude = create ? ensureClaudeSection(config)
                : config.has("claude") && config.get("claude").isJsonObject()
                    ? config.getAsJsonObject("claude") : null;
        if (claude == null) {
            return null;
        }
        if (!claude.has(ACCOUNTS_KEY) || !claude.get(ACCOUNTS_KEY).isJsonObject()) {
            if (!create) {
                return null;
            }
            claude.add(ACCOUNTS_KEY, new JsonObject());
        }
        return claude.getAsJsonObject(ACCOUNTS_KEY);
    }

    private JsonObject ensureClaudeSection(JsonObject config) {
        if (!config.has("claude") || !config.get("claude").isJsonObject()) {
            JsonObject claude = new JsonObject();
            claude.add("providers", new JsonObject());
            claude.addProperty("current", "");
            config.add("claude", claude);
        }
        return config.getAsJsonObject("claude");
    }

    private String findAccountIdByEmail(JsonObject accounts, String email) {
        for (String id : accounts.keySet()) {
            JsonObject account = accounts.get(id).isJsonObject() ? accounts.getAsJsonObject(id) : null;
            if (account != null && email.equalsIgnoreCase(getString(account, "emailAddress"))) {
                return id;
            }
        }
        return null;
    }

    private String displayName(JsonObject oauthAccount, String email) {
        String name = getString(oauthAccount, "displayName");
        if (name == null) {
            name = getString(oauthAccount, "name");
        }
        return name == null || name.isBlank() ? email : name;
    }

    private String getString(JsonObject object, String key) {
        return object != null && object.has(key) && !object.get(key).isJsonNull()
                ? object.get(key).getAsString()
                : null;
    }

    private static class ChunkMarker {
        private final String generation;
        private final int count;

        private ChunkMarker(String generation, int count) {
            this.generation = generation;
            this.count = count;
        }
    }
}
