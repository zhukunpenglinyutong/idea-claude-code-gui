package com.github.claudecodegui.cli;

/**
 * Supported headless CLI tools shown in Settings → Provider Management → CLI.
 */
public enum CliToolId {
    GROK("grok", "Grok CLI", "grok"),
    KIMI("kimi", "Kimi CLI", "kimi"),
    OPENCODE("opencode", "OpenCode", "opencode"),
    PI("pi", "PI CLI", "pi"),
    OMP("omp", "OMP CLI", "omp"),
    DSH("dsh", "DeepSeek Harness", "dsh"),
    // MiMo Code (OpenCode fork); alt-name probing happens Node-side in resolveMimoCliPath.
    MIMO("mimo", "MiMo Code", "mimo");

    private final String id;
    private final String displayName;
    private final String binaryName;

    CliToolId(String id, String displayName, String binaryName) {
        this.id = id;
        this.displayName = displayName;
        this.binaryName = binaryName;
    }

    public String getId() {
        return id;
    }

    public String getDisplayName() {
        return displayName;
    }

    public String getBinaryName() {
        return binaryName;
    }

    public static CliToolId fromId(String raw) {
        if (raw == null || raw.isBlank()) {
            return null;
        }
        String normalized = raw.trim().toLowerCase();
        for (CliToolId tool : values()) {
            if (tool.id.equals(normalized)) {
                return tool;
            }
        }
        return null;
    }
}
