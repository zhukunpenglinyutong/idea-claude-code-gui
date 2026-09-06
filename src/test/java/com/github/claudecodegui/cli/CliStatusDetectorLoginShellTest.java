package com.github.claudecodegui.cli;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.util.Map;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * Unit tests for the login-shell lookup script builder and output parser in
 * {@link CliStatusDetector}. Process-spawning behavior is covered implicitly by
 * the parser contract: only {@code name=absolute-existing-path} lines survive.
 */
public class CliStatusDetectorLoginShellTest {

    /** Keep lookup fixtures independent of the host's installed shells. */
    @Rule
    public final TemporaryFolder temporaryFolder = new TemporaryFolder();

    @Test
    public void buildLookupScriptEmitsOneLinePerTool() {
        String script = CliStatusDetector.buildLookupScript(false);
        for (CliToolId tool : CliToolId.values()) {
            String binary = tool.getBinaryName();
            assertTrue("script must query " + binary,
                    script.contains("echo \"" + binary + "=$(command -v " + binary + " 2>/dev/null)\""));
        }
    }

    @Test
    public void buildLookupScriptUsesFishSyntaxForFish() {
        String script = CliStatusDetector.buildLookupScript(true);
        for (CliToolId tool : CliToolId.values()) {
            String binary = tool.getBinaryName();
            assertTrue("fish script must query " + binary,
                    script.contains("echo \"" + binary + "=\"(command -v " + binary + " 2>/dev/null)"));
        }
        // POSIX command substitution is a syntax error in fish.
        assertFalse(script.contains("$("));
    }

    /** Recognize an existing absolute path on every supported host. */
    @Test
    public void parseLoginShellLookupKeepsAbsoluteExistingPaths() throws Exception {
        String existing = this.temporaryFolder.newFile("shell").getAbsolutePath();
        Map<String, String> parsed = CliStatusDetector.parseLoginShellLookup(
                "omp=" + existing + "\n"
                        + "pi=\n"                       // not found: empty value dropped
                        + "kimi=omp not found\n"        // shell noise dropped
                        + "prompt% grok=relative/path\n"// non-absolute dropped
                        + "\n");
        assertEquals(Map.of("omp", existing), parsed);
    }

    @Test
    public void parseLoginShellLookupHandlesNullAndBlank() {
        assertTrue(CliStatusDetector.parseLoginShellLookup(null).isEmpty());
        assertTrue(CliStatusDetector.parseLoginShellLookup("").isEmpty());
        assertTrue(CliStatusDetector.parseLoginShellLookup("   \n  ").isEmpty());
    }

    /** Preserve equals signs in existing paths and reject missing files. */
    @Test
    public void parseLoginShellLookupSplitsOnFirstEqualsOnly() throws Exception {
        String existing = this.temporaryFolder.newFile("shell=extra").getAbsolutePath();
        // Values containing '=' (unusual but legal in paths) must not break parsing.
        Map<String, String> parsed = CliStatusDetector.parseLoginShellLookup(
                "omp=" + existing + "\npi=" + existing + "=missing\n");
        assertEquals(Map.of("omp", existing), parsed);
    }
}
