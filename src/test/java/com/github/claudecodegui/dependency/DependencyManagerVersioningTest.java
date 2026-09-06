package com.github.claudecodegui.dependency;

import org.junit.Test;

import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

public class DependencyManagerVersioningTest {
    @Test
    public void shouldUseRequestedVersionForMainPackage() {
        List<String> packages = DependencyManager.buildPackageSpecs(
                SdkDefinition.CLAUDE_SDK,
                "0.3.182"
        );

        assertEquals("@anthropic-ai/claude-agent-sdk@0.3.182", packages.get(0));
        assertEquals("@anthropic-ai/sdk", packages.get(1));
        assertEquals("@anthropic-ai/bedrock-sdk", packages.get(2));
    }

    @Test
    public void shouldFallbackToSdkDefaultVersionWhenRequestedVersionIsBlank() {
        List<String> packages = DependencyManager.buildPackageSpecs(
                SdkDefinition.CODEX_SDK,
                " "
        );

        assertEquals("@openai/codex-sdk@latest", packages.get(0));
    }

    @Test
    public void shouldNormalizeLeadingVInRequestedVersion() {
        assertEquals("0.3.182", DependencyManager.normalizeRequestedVersion(" v0.3.182 "));
    }

    @Test
    public void shouldAcceptValidSemverVersions() {
        assertEquals("1.0.0", DependencyManager.normalizeRequestedVersion("1.0.0"));
        assertEquals("0.3.182", DependencyManager.normalizeRequestedVersion("V0.3.182"));
        assertEquals("1.2.3-beta.1", DependencyManager.normalizeRequestedVersion("1.2.3-beta.1"));
        assertEquals("2.0.0-rc.1", DependencyManager.normalizeRequestedVersion("v2.0.0-rc.1"));
    }

    @Test
    public void shouldRejectInvalidVersionFormats() {
        assertNull(DependencyManager.normalizeRequestedVersion("not-a-version"));
        assertNull(DependencyManager.normalizeRequestedVersion("1.0"));
        assertNull(DependencyManager.normalizeRequestedVersion("latest"));
        assertNull(DependencyManager.normalizeRequestedVersion(">=1.0.0"));
        assertNull(DependencyManager.normalizeRequestedVersion("1.0.0 && rm -rf /"));
    }

    @Test
    public void shouldRejectNullAndEmpty() {
        assertNull(DependencyManager.normalizeRequestedVersion(null));
        assertNull(DependencyManager.normalizeRequestedVersion(""));
        assertNull(DependencyManager.normalizeRequestedVersion("   "));
    }

    @Test
    public void claudeSdkShouldRequireFableCapableMinimumVersion() {
        // The Fable tier (ANTHROPIC_DEFAULT_FABLE_MODEL + 'fable' alias) needs SDK 0.3.182+.
        // Pinning this floor here prevents accidental downgrade that would resurrect the
        // "model fable" 401 on third-party relays.
        assertEquals("0.3.182", SdkDefinition.CLAUDE_SDK.getMinRequiredVersion());
    }

    @Test
    public void codexSdkShouldRequireNativeAutoReviewMinimumVersion() {
        // The plugin uses CodexOptions.config.approvals_reviewer, which is present in the verified 0.146.0 SDK.
        assertEquals("0.146.0", SdkDefinition.CODEX_SDK.getMinRequiredVersion());
    }
}
