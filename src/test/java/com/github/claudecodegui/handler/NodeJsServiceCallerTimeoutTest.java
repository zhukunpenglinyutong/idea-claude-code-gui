package com.github.claudecodegui.handler;

import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.provider.claude.ClaudeSDKBridge;
import com.github.claudecodegui.bridge.ProcessManager;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.File;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

/**
 * Regression tests for the executeNodeScript timeout: stdout used to be
 * drained to EOF BEFORE the timeout was checked, so a hung child holding the
 * pipe open blocked forever and the 30s timeout was unreachable dead code.
 */
public class NodeJsServiceCallerTimeoutTest {

    @Rule
    public final TemporaryFolder temporaryFolder = new TemporaryFolder();

    private static final long TEST_TIMEOUT_SECONDS = 2;

    @Test(timeout = 20_000)
    public void hungChildTimesOutInsteadOfBlockingForever() throws Exception {
        TestClaudeSDKBridge bridge = new TestClaudeSDKBridge();
        NodeJsServiceCaller caller = new NodeJsServiceCaller(bridge.context, (int) TEST_TIMEOUT_SECONDS);

        // Child prints nothing and stays alive holding the pipe open.
        ProcessBuilder pb = new ProcessBuilder(List.of(
                "node", "-e", "setTimeout(() => {}, 60_000);"));
        pb.redirectErrorStream(true);

        long start = System.currentTimeMillis();
        try {
            caller.executeNodeScript(pb);
            fail("expected the hung child to be terminated by the timeout");
        } catch (Exception e) {
            assertTrue("expected a timeout error, got: " + e.getMessage(),
                    e.getMessage().contains("timed out"));
        }
        long elapsed = System.currentTimeMillis() - start;

        assertTrue("timeout should fire promptly (took " + elapsed + " ms)",
                elapsed < TEST_TIMEOUT_SECONDS * 1000 + 5_000);
        assertEquals("child should be unregistered after the timeout",
                0, bridge.getProcessManager().getActiveProcessCount());
    }

    private static final class TestClaudeSDKBridge extends ClaudeSDKBridge {
        private final ProcessManager processManager = new ProcessManager();
        private final HandlerContext context;

        private TestClaudeSDKBridge() {
            this.context = new HandlerContext(null, this, null, null, new HandlerContext.JsCallback() {
                @Override
                public void callJavaScript(String functionName, String... args) {
                }

                @Override
                public String escapeJs(String str) {
                    return str;
                }
            });
        }

        @Override
        public File getSdkTestDir() {
            return new File(".");
        }

        @Override
        public String getNodeExecutable() {
            return "node";
        }

        @Override
        public ProcessManager getProcessManager() {
            return processManager;
        }
    }
}
