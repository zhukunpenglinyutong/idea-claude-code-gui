package com.github.claudecodegui.provider.gemini;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assume.assumeTrue;

public class GeminiHistoryReaderTest {

    @Rule
    public TemporaryFolder tempDir = new TemporaryFolder();

    @Test
    public void testListSessionsAndParseSummary() throws Exception {
        File brainDir = tempDir.newFolder("brain");
        File historyFile = tempDir.newFile("history.jsonl");

        String sessionId = "12345678-abcd-ef01-2345-6789abcdef01";
        File sessionDir = new File(brainDir, sessionId);
        File logsDir = new File(sessionDir, ".system_generated/logs");
        assertTrue(logsDir.mkdirs());

        File transcriptFile = new File(logsDir, "transcript.jsonl");
        String transcriptContent =
                "{\"step_index\":0,\"source\":\"USER_EXPLICIT\",\"type\":\"USER_INPUT\",\"created_at\":\"2026-08-07T10:00:00Z\",\"content\":\"<USER_REQUEST>Test Gemini Request</USER_REQUEST>\"}\n" +
                "{\"step_index\":1,\"source\":\"MODEL\",\"type\":\"PLANNER_RESPONSE\",\"created_at\":\"2026-08-07T10:00:05Z\",\"content\":\"Here is the response\"}\n";
        Files.writeString(transcriptFile.toPath(), transcriptContent, StandardCharsets.UTF_8);

        String historyContent = "{\"conversationId\":\"" + sessionId + "\",\"workspace\":\"/test/project/path\"}\n";
        Files.writeString(historyFile.toPath(), historyContent, StandardCharsets.UTF_8);

        GeminiHistoryReader reader = new GeminiHistoryReader(brainDir.toPath(), historyFile.toPath(), new Gson());
        List<GeminiHistoryReader.SessionInfo> sessions = reader.listAllSessions();

        assertEquals(1, sessions.size());
        GeminiHistoryReader.SessionInfo info = sessions.get(0);
        assertEquals(sessionId, info.sessionId);
        assertEquals("Test Gemini Request", info.title);
        assertEquals(2, info.messageCount);
        assertEquals("/test/project/path", info.cwd);
        assertEquals("gemini", info.provider);

        String jsonResult = reader.getSessionsForProjectAsJson("/test/project/path");
        JsonObject json = JsonParser.parseString(jsonResult).getAsJsonObject();
        assertTrue(json.get("success").getAsBoolean());
        assertEquals(1, json.get("sessionCount").getAsInt());
    }

    @Test
    public void testDeleteSession() throws Exception {
        File brainDir = tempDir.newFolder("brain");
        File historyFile = tempDir.newFile("history.jsonl");

        String sessionId = "session-to-delete";
        File sessionDir = new File(brainDir, sessionId);
        assertTrue(sessionDir.mkdirs());
        File dummyFile = new File(sessionDir, "data.txt");
        assertTrue(dummyFile.createNewFile());

        GeminiHistoryReader reader = new GeminiHistoryReader(brainDir.toPath(), historyFile.toPath(), new Gson());
        assertTrue(reader.deleteSession(sessionId));
        assertFalse(sessionDir.exists());
    }

    @Test
    public void testGetSessionMessages() throws Exception {
        File brainDir = tempDir.newFolder("brain");
        File historyFile = tempDir.newFile("history.jsonl");

        String sessionId = "session-messages-test";
        File sessionDir = new File(brainDir, sessionId);
        File logsDir = new File(sessionDir, ".system_generated/logs");
        assertTrue(logsDir.mkdirs());

        File transcriptFile = new File(logsDir, "transcript.jsonl");
        String transcriptContent =
                "{\"step_index\":0,\"source\":\"USER_EXPLICIT\",\"type\":\"USER_INPUT\",\"created_at\":\"2026-08-07T10:00:00Z\",\"content\":\"<USER_REQUEST>Hello AI</USER_REQUEST>\"}\n" +
                "{\"step_index\":1,\"source\":\"MODEL\",\"type\":\"PLANNER_RESPONSE\",\"created_at\":\"2026-08-07T10:00:05Z\",\"content\":\"Hello Human!\",\"tool_calls\":[{\"name\":\"view_file\",\"args\":{\"AbsolutePath\":\"/tmp/test\"}}]}\n" +
                "{\"step_index\":2,\"source\":\"MODEL\",\"type\":\"VIEW_FILE\",\"created_at\":\"2026-08-07T10:00:06Z\",\"content\":\"File content here\"}\n";
        Files.writeString(transcriptFile.toPath(), transcriptContent, StandardCharsets.UTF_8);

        GeminiHistoryReader reader = new GeminiHistoryReader(brainDir.toPath(), historyFile.toPath(), new Gson());
        List<JsonObject> messages = reader.getSessionMessages(sessionId, null);

        assertNotNull(messages);
        assertFalse(messages.isEmpty());

        // Should have user text message, assistant text + tool_use, and tool_result
        assertTrue(messages.size() >= 3);
        assertEquals("user", messages.get(0).get("type").getAsString());
        assertEquals("assistant", messages.get(1).get("type").getAsString());

        String jsonMessages = reader.getSessionMessagesAsJson(sessionId);
        assertNotNull(jsonMessages);
        assertTrue(jsonMessages.contains("Hello Human!"));
    }

    @Test
    public void testDeleteSessionRejectsDotIdWithoutTouchingBrainTree() throws Exception {
        File brainDir = tempDir.newFolder("brain");
        File historyFile = tempDir.newFile("history.jsonl");

        // A real session that must survive a "." delete attempt.
        File sessionDir = new File(brainDir, "session-to-keep");
        assertTrue(sessionDir.mkdirs());
        assertTrue(new File(sessionDir, "data.txt").createNewFile());

        GeminiHistoryReader reader = new GeminiHistoryReader(brainDir.toPath(), historyFile.toPath(), new Gson());

        // "." resolves to brainRoot itself — accepting it would recursively
        // delete EVERY session at once.
        assertFalse(reader.deleteSession("."));
        assertTrue(sessionDir.exists());
        assertTrue(brainDir.exists());

        // Traversal and separator ids stay rejected on the delete path too.
        assertFalse(reader.deleteSession(".."));
        assertFalse(reader.deleteSession("../outside"));
        assertFalse(reader.deleteSession("sub/dir"));
        assertFalse(reader.deleteSession("dir\\sub"));
        assertTrue(sessionDir.exists());
    }

    @Test
    public void testGetSessionMessagesRejectsInvalidIds() throws Exception {
        File brainDir = tempDir.newFolder("brain");
        File historyFile = tempDir.newFile("history.jsonl");

        GeminiHistoryReader reader = new GeminiHistoryReader(brainDir.toPath(), historyFile.toPath(), new Gson());

        assertTrue(reader.getSessionMessages(".", null).isEmpty());
        assertTrue(reader.getSessionMessages("..", null).isEmpty());
        assertTrue(reader.getSessionMessages("../escape", null).isEmpty());
        assertTrue(reader.getSessionMessages("sub/dir", null).isEmpty());
    }

    @Test
    public void testDeleteSessionRejectsSymlinkedSessionDir() throws Exception {
        File brainDir = tempDir.newFolder("brain");
        File historyFile = tempDir.newFile("history.jsonl");

        // Outside target with content that must survive.
        File targetDir = tempDir.newFolder("precious");
        File targetFile = new File(targetDir, "keep-me.txt");
        assertTrue(targetFile.createNewFile());

        Path link = new File(brainDir, "symlinked-session").toPath();
        boolean symlinkCreated = true;
        try {
            Files.createSymbolicLink(link, targetDir.toPath());
        } catch (UnsupportedOperationException | IOException e) {
            // Symlinks unavailable (e.g. Windows without privileges) — skip.
            symlinkCreated = false;
        }
        assumeTrue("symbolic links not supported here", symlinkCreated);

        GeminiHistoryReader reader = new GeminiHistoryReader(brainDir.toPath(), historyFile.toPath(), new Gson());
        // NOFOLLOW: the link must read as non-directory; the delete refuses
        // and never recurses into the link target.
        assertFalse(reader.deleteSession("symlinked-session"));
        assertTrue(targetFile.exists());
    }

    @Test
    public void testGetSessionMessagesRejectsSymlinkedSessionDir() throws Exception {
        File brainDir = tempDir.newFolder("brain");
        File historyFile = tempDir.newFile("history.jsonl");

        // Outside tree shaped like a session with a transcript — a symlink at
        // the session slot must NOT make it readable history.
        File targetDir = tempDir.newFolder("outside-tree");
        File logsDir = new File(targetDir, ".system_generated/logs");
        assertTrue(logsDir.mkdirs());
        File transcriptFile = new File(logsDir, "transcript.jsonl");
        Files.writeString(transcriptFile.toPath(),
                "{\"type\":\"USER_INPUT\",\"content\":\"<USER_REQUEST>leaked</USER_REQUEST>\"}\n",
                StandardCharsets.UTF_8);

        Path link = new File(brainDir, "symlinked-read").toPath();
        boolean symlinkCreated = true;
        try {
            Files.createSymbolicLink(link, targetDir.toPath());
        } catch (UnsupportedOperationException | IOException e) {
            symlinkCreated = false;
        }
        assumeTrue("symbolic links not supported here", symlinkCreated);

        GeminiHistoryReader reader = new GeminiHistoryReader(brainDir.toPath(), historyFile.toPath(), new Gson());
        // Read must not be the weaker sibling of delete: NOFOLLOW makes the
        // link read as non-directory, containment keeps the target out.
        assertTrue(reader.getSessionMessages("symlinked-read", null).isEmpty());
    }

    @Test
    public void testDeleteSessionRemovesInnerSymlinkWithoutTouchingTarget() throws Exception {
        File brainDir = tempDir.newFolder("brain");
        File historyFile = tempDir.newFile("history.jsonl");

        String sessionId = "session-with-inner-link";
        File sessionDir = new File(brainDir, sessionId);
        assertTrue(sessionDir.mkdirs());
        assertTrue(new File(sessionDir, "data.txt").createNewFile());

        // A file OUTSIDE the brain tree that must survive the session delete.
        File outsideTarget = tempDir.newFile("outside-target.txt");
        Path innerLink = new File(sessionDir, "innocent-looking.txt").toPath();
        boolean symlinkCreated = true;
        try {
            Files.createSymbolicLink(innerLink, outsideTarget.toPath());
        } catch (UnsupportedOperationException | IOException e) {
            symlinkCreated = false;
        }
        assumeTrue("symbolic links not supported here", symlinkCreated);

        GeminiHistoryReader reader = new GeminiHistoryReader(brainDir.toPath(), historyFile.toPath(), new Gson());
        assertTrue(reader.deleteSession(sessionId));
        assertFalse(sessionDir.exists());
        // The link was removed as a link — its target survives untouched.
        assertTrue(outsideTarget.exists());
    }

    @Test
    public void testGetSessionMessagesSkipsOnlyMalformedLines() throws Exception {
        File brainDir = tempDir.newFolder("brain");
        File historyFile = tempDir.newFile("history.jsonl");

        String sessionId = "session-malformed-mid";
        File sessionDir = new File(brainDir, sessionId);
        File logsDir = new File(sessionDir, ".system_generated/logs");
        assertTrue(logsDir.mkdirs());

        File transcriptFile = new File(logsDir, "transcript.jsonl");
        String transcriptContent =
                // valid user line …
                "{\"step_index\":0,\"type\":\"USER_INPUT\",\"created_at\":\"2026-08-07T10:00:00Z\",\"content\":\"<USER_REQUEST>first</USER_REQUEST>\"}\n" +
                // … a JSON-valid line whose content is an OBJECT (getAsString
                // throws — must skip this line only, not the whole parse) …
                "{\"step_index\":1,\"type\":\"USER_INPUT\",\"content\":{\"nested\":\"object\"}}\n" +
                // … not-JSON garbage …
                "}}} this is not json {{{\n" +
                // … another valid line that must still come through.
                "{\"step_index\":2,\"type\":\"PLANNER_RESPONSE\",\"created_at\":\"2026-08-07T10:00:05Z\",\"content\":\"after the garbage\"}\n";
        Files.writeString(transcriptFile.toPath(), transcriptContent, StandardCharsets.UTF_8);

        GeminiHistoryReader reader = new GeminiHistoryReader(brainDir.toPath(), historyFile.toPath(), new Gson());
        List<JsonObject> messages = reader.getSessionMessages(sessionId, null);

        // Both valid lines survive around the malformed ones (AC13).
        String json = new Gson().toJson(messages);
        assertTrue(json.contains("first"));
        assertTrue(json.contains("after the garbage"));
        assertFalse(json.contains("nested"));
    }

    @Test
    public void testGetSessionMessagesRejectsWindowsIllegalChars() throws Exception {
        File brainDir = tempDir.newFolder("brain");
        File historyFile = tempDir.newFile("history.jsonl");

        GeminiHistoryReader reader = new GeminiHistoryReader(brainDir.toPath(), historyFile.toPath(), new Gson());

        // Windows-illegal chars previously slipped the denylist and made
        // brainRoot.resolve throw unchecked InvalidPathException.
        assertTrue(reader.getSessionMessages("bad:id", null).isEmpty());
        assertTrue(reader.getSessionMessages("star*id", null).isEmpty());
        assertTrue(reader.getSessionMessages("q?id", null).isEmpty());
        assertTrue(reader.getSessionMessages("pipe|id", null).isEmpty());
        assertFalse(reader.deleteSession("bad:id"));
    }

    @Test
    public void testExtractCwdFromContentWindowsPaths() throws Exception {
        File brainDir = tempDir.newFolder("brain");
        File historyFile = tempDir.newFile("history.jsonl");
        GeminiHistoryReader reader = new GeminiHistoryReader(brainDir.toPath(), historyFile.toPath(), new Gson());

        // Drive-letter workspace line (both separator spellings).
        String driveContent = "<user_information>\nHere is useful info about you:\nC:\\work\\proj -> active\n</user_information>";
        assertEquals("C:\\work\\proj", reader.extractCwdFromContent(driveContent));

        String fwdContent = "<user_information>\nD:/work/proj -> active\n</user_information>";
        assertEquals("D:/work/proj", reader.extractCwdFromContent(fwdContent));

        // UNC workspace line (\\server\share\…) — never matched before the
        // explicit prefix was accepted.
        String uncContent = "Here is useful info about the active workspaces:\n\\\\server\\share\\proj -> active\n";
        assertEquals("\\\\server\\share\\proj", reader.extractCwdFromContent(uncContent));

        // Non-path lines never match.
        assertNull(reader.extractCwdFromContent("<user_information>\nnothing here -> meta\n</user_information>"));
    }

    @Test
    public void testGetSessionMessagesRejectsSymlinkedTranscript() throws Exception {
        File brainDir = tempDir.newFolder("brain");
        File historyFile = tempDir.newFile("history.jsonl");

        // A REAL session dir inside the brain root; the transcript slot is a
        // symlink to an outside file — the session-dir guard stops one level
        // early, so the transcript check itself must refuse to follow.
        String sessionId = "session-with-linked-transcript";
        File sessionDir = new File(brainDir, sessionId);
        File logsDir = new File(sessionDir, ".system_generated/logs");
        assertTrue(logsDir.mkdirs());

        File outsideTranscript = tempDir.newFile("outside-transcript.jsonl");
        Files.writeString(outsideTranscript.toPath(),
                "{\"type\":\"USER_INPUT\",\"content\":\"<USER_REQUEST>leaked via transcript link</USER_REQUEST>\"}\n",
                StandardCharsets.UTF_8);

        Path link = new File(logsDir, "transcript.jsonl").toPath();
        boolean symlinkCreated = true;
        try {
            Files.createSymbolicLink(link, outsideTranscript.toPath());
        } catch (UnsupportedOperationException | IOException e) {
            symlinkCreated = false;
        }
        assumeTrue("symbolic links not supported here", symlinkCreated);

        GeminiHistoryReader reader = new GeminiHistoryReader(brainDir.toPath(), historyFile.toPath(), new Gson());
        // NOFOLLOW: the linked transcript reads as absent; the outside file
        // content never becomes readable history.
        assertTrue(reader.getSessionMessages(sessionId, null).isEmpty());
        assertTrue(outsideTranscript.exists());
    }

    @Test
    public void testGetSessionMessagesResolvesTrimmedId() throws Exception {
        File brainDir = tempDir.newFolder("brain");
        File historyFile = tempDir.newFile("history.jsonl");

        // Validation checks the TRIMMED id, so the probe must resolve the same
        // trimmed value — a padded id previously probed a phantom " abc " dir.
        String sessionId = "trimmed-id-session";
        File sessionDir = new File(brainDir, sessionId);
        File logsDir = new File(sessionDir, ".system_generated/logs");
        assertTrue(logsDir.mkdirs());
        File transcriptFile = new File(logsDir, "transcript.jsonl");
        Files.writeString(transcriptFile.toPath(),
                "{\"step_index\":0,\"type\":\"USER_INPUT\",\"created_at\":\"2026-08-07T10:00:00Z\",\"content\":\"<USER_REQUEST>via trimmed id</USER_REQUEST>\"}\n",
                StandardCharsets.UTF_8);

        GeminiHistoryReader reader = new GeminiHistoryReader(brainDir.toPath(), historyFile.toPath(), new Gson());
        List<JsonObject> messages = reader.getSessionMessages("  " + sessionId + "  ", null);
        assertFalse(messages.isEmpty());
        assertTrue(new Gson().toJson(messages).contains("via trimmed id"));
    }

    @Test
    public void testDeleteSessionResolvesTrimmedId() throws Exception {
        File brainDir = tempDir.newFolder("brain");
        File historyFile = tempDir.newFile("history.jsonl");

        String sessionId = "trimmed-delete-session";
        File sessionDir = new File(brainDir, sessionId);
        assertTrue(sessionDir.mkdirs());
        assertTrue(new File(sessionDir, "data.txt").createNewFile());

        GeminiHistoryReader reader = new GeminiHistoryReader(brainDir.toPath(), historyFile.toPath(), new Gson());
        // Delete targets the trimmed id too — the padded form must reach the
        // real dir, not a phantom one (and report success).
        assertTrue(reader.deleteSession(" " + sessionId + " "));
        assertFalse(sessionDir.exists());
    }
}
