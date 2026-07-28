package com.github.claudecodegui.settings;

import com.intellij.credentialStore.CredentialAttributes;
import com.intellij.credentialStore.Credentials;
import com.intellij.ide.passwordSafe.PasswordSafe;
import com.intellij.openapi.diagnostic.Logger;
import org.jetbrains.annotations.Nullable;

/** Stores managed Codex provider auth JSON in JetBrains PasswordSafe. */
public class CodexProviderCredentialStore {

    private static final Logger LOG = Logger.getInstance(CodexProviderCredentialStore.class);
    private static final String SERVICE_PREFIX = "CC GUI/Codex Provider/";

    public boolean isPersistentStorageAvailable() {
        try {
            return !PasswordSafe.getInstance().isMemoryOnly();
        } catch (RuntimeException e) {
            return false;
        }
    }

    public boolean writeVerified(String providerId, String authJson) {
        if (!isValidId(providerId) || authJson == null || !isPersistentStorageAvailable()) {
            return false;
        }
        try {
            PasswordSafe.getInstance().set(attributes(providerId), new Credentials(providerId, authJson));
            return authJson.equals(read(providerId));
        } catch (RuntimeException e) {
            LOG.warn("[CodexCredentials] PasswordSafe write failed for provider " + providerId
                    + "; errorClass=" + e.getClass().getSimpleName());
            return false;
        }
    }

    public @Nullable String read(String providerId) {
        if (!isValidId(providerId)) {
            return null;
        }
        try {
            Credentials credentials = PasswordSafe.getInstance().get(attributes(providerId));
            return credentials == null ? null : credentials.getPasswordAsString();
        } catch (RuntimeException e) {
            LOG.warn("[CodexCredentials] PasswordSafe read failed for provider " + providerId
                    + "; errorClass=" + e.getClass().getSimpleName());
            return null;
        }
    }

    public void delete(String providerId) {
        if (!isValidId(providerId)) {
            return;
        }
        try {
            PasswordSafe.getInstance().set(attributes(providerId), null);
        } catch (RuntimeException e) {
            LOG.warn("[CodexCredentials] PasswordSafe delete failed for provider " + providerId
                    + "; errorClass=" + e.getClass().getSimpleName());
        }
    }

    public boolean deleteVerified(String providerId) {
        if (!isValidId(providerId) || !isPersistentStorageAvailable()) {
            return false;
        }
        try {
            PasswordSafe.getInstance().set(attributes(providerId), null);
            return PasswordSafe.getInstance().get(attributes(providerId)) == null;
        } catch (RuntimeException e) {
            LOG.warn("[CodexCredentials] PasswordSafe verified delete failed for provider " + providerId
                    + "; errorClass=" + e.getClass().getSimpleName());
            return false;
        }
    }

    private static CredentialAttributes attributes(String providerId) {
        return new CredentialAttributes(SERVICE_PREFIX + providerId, providerId);
    }

    private static boolean isValidId(String providerId) {
        return providerId != null && !providerId.isBlank() && providerId.length() <= 256;
    }
}
