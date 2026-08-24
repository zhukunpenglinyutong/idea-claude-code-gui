package com.github.claudecodegui.dependency;

import java.util.Arrays;
import java.util.Collections;
import java.util.List;

/**
 * SDK definition enum.
 * Defines the installable AI SDK package information.
 */
public enum SdkDefinition {

    CLAUDE_SDK(
        "claude-sdk",
        "Claude Code SDK",
        "@anthropic-ai/claude-agent-sdk",
        // The Fable tier (ANTHROPIC_DEFAULT_FABLE_MODEL env + the 'fable' model alias)
        // was introduced in SDK 0.3.182. Older 0.2.x CLIs don't recognize the alias and
        // pass it through as a literal model name, so third-party relays without a model
        // literally called "fable" reject requests with a 401 ("model fable" / "No
        // available channel"). Pin the floor at 0.3.182 to guarantee Fable support.
        "^0.3.182",
        Arrays.asList("@anthropic-ai/sdk", "@anthropic-ai/bedrock-sdk"),
        Arrays.asList("0.3.220", "0.3.201", "0.3.182"),
        "Claude AI 提供商所需，包含 Agent SDK 和 Bedrock 支持。",
        "0.3.182" // minRequiredVersion — Fable tier (ANTHROPIC_DEFAULT_FABLE_MODEL) needs SDK >= 0.3.182
    ),

    CODEX_SDK(
        "codex-sdk",
        "Codex SDK",
        "@openai/codex-sdk",
        "latest",
        Collections.emptyList(),
        Arrays.asList("0.117.0", "0.116.0", "0.115.0"),
        "Codex AI 提供商所需。",
        null // minRequiredVersion — no enforced minimum
    ),

    /**
     * Gemini uses Antigravity CLI ({@code agy}) headless stream-json — not an npm SDK.
     * Install externally; path via AGY_PATH / AGY_CLI_PATH or PATH.
     */
    GEMINI_CLI(
        "gemini-cli",
        "Antigravity CLI (Gemini)",
        "agy-cli-binary",
        "latest",
        Collections.emptyList(),
        Collections.emptyList(),
        "Gemini provider requires Antigravity CLI (agy). Install from https://antigravity.google/docs/cli/install and sign in once via agy.",
        null
    );

    private final String id;
    private final String displayName;
    private final String npmPackage;
    private final String version;
    private final List<String> dependencies;
    private final List<String> fallbackVersions;
    private final String description;
    private final String minRequiredVersion;

    SdkDefinition(String id, String displayName, String npmPackage, String version,
                  List<String> dependencies, List<String> fallbackVersions, String description,
                  String minRequiredVersion) {
        this.id = id;
        this.displayName = displayName;
        this.npmPackage = npmPackage;
        this.version = version;
        this.dependencies = dependencies;
        this.fallbackVersions = fallbackVersions;
        this.description = description;
        this.minRequiredVersion = minRequiredVersion;
    }

    public String getId() {
        return id;
    }

    public String getDisplayName() {
        return displayName;
    }

    public String getNpmPackage() {
        return npmPackage;
    }

    public String getVersion() {
        return version;
    }

    public List<String> getDependencies() {
        return dependencies;
    }

    public List<String> getFallbackVersions() {
        return fallbackVersions;
    }

    public String getDescription() {
        return description;
    }

    /**
     * Minimum installed version required for full feature support.
     * The Claude SDK needs 0.3.182 or later for the Fable tier; Codex has no minimum.
     * Null means no minimum is enforced.
     */
    public String getMinRequiredVersion() {
        return minRequiredVersion;
    }

    /**
     * Returns the full npm package specifier including the version.
     * For example: @anthropic-ai/claude-agent-sdk@^0.1.76
     */
    public String getFullPackageSpec() {
        return npmPackage + "@" + version;
    }

    /**
     * Returns all packages to install (main package + dependencies).
     */
    public List<String> getAllPackages() {
        if (dependencies.isEmpty()) {
            return Collections.singletonList(getFullPackageSpec());
        }
        java.util.ArrayList<String> all = new java.util.ArrayList<>();
        all.add(getFullPackageSpec());
        all.addAll(dependencies);
        return all;
    }

    /**
     * Finds an SDK definition by its ID.
     */
    public static SdkDefinition fromId(String id) {
        for (SdkDefinition sdk : values()) {
            if (sdk.getId().equals(id)) {
                return sdk;
            }
        }
        return null;
    }

    /**
     * Finds the corresponding SDK by provider name.
     */
    public static SdkDefinition fromProvider(String provider) {
        if ("claude".equalsIgnoreCase(provider)) {
            return CLAUDE_SDK;
        } else if ("codex".equalsIgnoreCase(provider)) {
            return CODEX_SDK;
        } else if ("gemini".equalsIgnoreCase(provider)) {
            return GEMINI_CLI;
        }
        return null;
    }
}
