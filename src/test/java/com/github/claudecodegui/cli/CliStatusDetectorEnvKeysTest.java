package com.github.claudecodegui.cli;

import org.junit.Test;

import java.util.Arrays;
import java.util.List;
import java.util.stream.Collectors;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;

/**
 * Pins the env-key contract between the Java availability probe and the JS
 * resolver: a key listed here but ignored by resolveAgyBinary (etc.) would
 * report the CLI "available" while every send still fails.
 */
public class CliStatusDetectorEnvKeysTest {

    @Test
    public void agyEnvKeysMatchTheJsResolver() {
        // resolveAgyBinary honors ONLY AGY_PATH / AGY_CLI_PATH (plus the
        // GEMINI_CLI_PATH hint it deliberately ignores). AGY_BIN and
        // ANTIGRAVITY_BIN were never read by the bridge.
        List<String> keys = Arrays.asList(CliStatusDetector.envKeysFor(CliToolId.AGY));
        assertEquals(2, keys.size());
        assertEquals("AGY_PATH", keys.get(0));
        assertEquals("AGY_CLI_PATH", keys.get(1));
        assertFalse(keys.contains("AGY_BIN"));
        assertFalse(keys.contains("ANTIGRAVITY_BIN"));
        assertFalse(keys.contains("GEMINI_CLI_PATH"));
    }

    @Test
    public void everyToolHasAtLeastOneEnvKey() {
        for (CliToolId tool : CliToolId.values()) {
            assertFalse(
                    tool + " must declare at least one env key",
                    CliStatusDetector.envKeysFor(tool).length == 0);
        }
    }

    /**
     * Pins the home-bin-dir contract: resolveAgyBinary probes ~/.local/bin,
     * ~/.gemini/antigravity-cli/bin, ~/.antigravity/bin and ~/bin — a dir one
     * side probes and the other does not means "available" status with failing
     * sends (the same mismatch class the env-key pin above exists to prevent).
     */
    @Test
    public void agyHomeBinDirsMatchTheJsResolver() {
        List<String> raw = CliStatusDetector.homeBinDirs(CliToolId.AGY, "/home/u");
        List<String> dirs = raw.stream().map(d -> d.replace('\\', '/')).collect(Collectors.toList());
        // The tool-specific head is the parity surface — the shared npm /
        // package-manager tail appended below the switch is out of scope.
        assertEquals(Arrays.asList(
                "/home/u/.gemini/antigravity-cli/bin",
                "/home/u/.antigravity/bin",
                "/home/u/.local/bin",
                "/home/u/bin"), dirs.subList(0, 4));
    }
}
