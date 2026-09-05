package com.github.claudecodegui.provider.opencode;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import org.junit.Test;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.Statement;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class OpenCodeHistoryReaderTest {

    @Test
    public void pathsMatchNormalizesWindowsSeparators() {
        assertTrue(OpenCodeHistoryReader.pathsMatch(
                "D:\\software\\my project",
                "d:/software/my project"));
    }

    @Test
    public void pathsMatchAcceptsParentAndChildDirectories() {
        assertTrue(OpenCodeHistoryReader.pathsMatch(
                "/Users/me/proj",
                "/Users/me/proj/ai-bridge"));
        assertTrue(OpenCodeHistoryReader.pathsMatch(
                "/Users/me/proj/ai-bridge",
                "/Users/me/proj"));
        assertTrue(OpenCodeHistoryReader.pathsMatch(
                "/private/tmp/work",
                "/tmp/work"));
        assertFalse(OpenCodeHistoryReader.pathsMatch(
                "/Users/me/proj-a",
                "/Users/me/proj-b"));
    }

    @Test
    public void normalizeOpenCodeModelParsesJsonAndPlainIds() {
        assertEquals(
                "opencode/deepseek-v4-flash-free",
                OpenCodeHistoryReader.normalizeOpenCodeModel(
                        "{\"id\":\"deepseek-v4-flash-free\",\"providerID\":\"opencode\",\"variant\":\"default\"}"));
        assertEquals(
                "openai/gpt-5",
                OpenCodeHistoryReader.normalizeOpenCodeModel("openai/gpt-5"));
    }

    @Test
    public void listsAndLoadsSessionFromStorageLayout() throws Exception {
        Path storage = Files.createTempDirectory("oc-history-test");
        String sessionId = "ses_test123abc";
        String projectHash = "abc123hash";

        Path sessionFile = storage.resolve("session").resolve(projectHash).resolve(sessionId + ".json");
        Files.createDirectories(sessionFile.getParent());
        Files.writeString(sessionFile, """
                {
                  "id": "%s",
                  "projectID": "%s",
                  "directory": "D:\\\\develop\\\\my-app",
                  "title": "Windows OpenCode chat",
                  "time": { "created": 1000, "updated": 2000 }
                }
                """.formatted(sessionId, projectHash), StandardCharsets.UTF_8);

        String userMsgId = "msg_user1";
        String asstMsgId = "msg_asst1";
        Path userMsg = storage.resolve("message").resolve(sessionId).resolve(userMsgId + ".json");
        Path asstMsg = storage.resolve("message").resolve(sessionId).resolve(asstMsgId + ".json");
        Files.createDirectories(userMsg.getParent());
        Files.writeString(userMsg, """
                {"id":"%s","sessionID":"%s","role":"user","time":{"created":1001}}
                """.formatted(userMsgId, sessionId), StandardCharsets.UTF_8);
        Files.writeString(asstMsg, """
                {"id":"%s","sessionID":"%s","role":"assistant","time":{"created":1002}}
                """.formatted(asstMsgId, sessionId), StandardCharsets.UTF_8);

        Path userPart = storage.resolve("part").resolve(userMsgId).resolve("prt_1.json");
        Path asstText = storage.resolve("part").resolve(asstMsgId).resolve("prt_2.json");
        Path asstTool = storage.resolve("part").resolve(asstMsgId).resolve("prt_3.json");
        Files.createDirectories(userPart.getParent());
        Files.createDirectories(asstText.getParent());
        Files.writeString(userPart, """
                {"id":"prt_1","type":"text","text":"hello opencode","messageID":"%s"}
                """.formatted(userMsgId), StandardCharsets.UTF_8);
        Files.writeString(asstText, """
                {"id":"prt_2","type":"text","text":"world","messageID":"%s"}
                """.formatted(asstMsgId), StandardCharsets.UTF_8);
        Files.writeString(asstTool, """
                {
                  "id":"prt_3","type":"tool","callID":"call_1","tool":"read",
                  "messageID":"%s",
                  "state":{"status":"completed","input":{"filePath":"a.txt"},"output":"ok"}
                }
                """.formatted(asstMsgId), StandardCharsets.UTF_8);

        // No SQLite file → pure legacy JSON path.
        Path missingDb = storage.resolveSibling("missing-opencode.db");
        OpenCodeHistoryReader reader = new OpenCodeHistoryReader(storage, missingDb, new Gson());

        List<OpenCodeHistoryReader.SessionInfo> listed =
                reader.listSessionsForProject("D:/develop/my-app");
        assertEquals(1, listed.size());
        assertEquals(sessionId, listed.get(0).sessionId);
        assertEquals("Windows OpenCode chat", listed.get(0).title);
        assertEquals(2, listed.get(0).messageCount);

        List<JsonObject> messages = reader.getSessionMessages(sessionId, "D:\\develop\\my-app");
        assertFalse(messages.isEmpty());
        assertEquals("user", messages.get(0).get("type").getAsString());
        assertTrue(messages.size() >= 2);

        boolean hasTool = messages.stream().anyMatch(m ->
                m.has("message")
                        && m.getAsJsonObject("message").has("content")
                        && m.getAsJsonObject("message").getAsJsonArray("content").toString().contains("tool_use"));
        assertTrue(hasTool);

        assertTrue(reader.deleteSession(sessionId, "D:/develop/my-app"));
        assertTrue(reader.listSessionsForProject("D:/develop/my-app").isEmpty());
    }

    @Test
    public void listsAndLoadsSessionFromSqliteDatabase() throws Exception {
        Path root = Files.createTempDirectory("oc-history-db");
        Path storage = root.resolve("storage");
        Files.createDirectories(storage);
        Path db = root.resolve("opencode.db");

        String sessionId = "ses_db_hello1";
        String projectPath = "/Users/me/Desktop/CC GUI 项目/jetbrains-cc-gui";
        String userMsgId = "msg_db_user1";
        String asstMsgId = "msg_db_asst1";

        Class.forName("org.sqlite.JDBC");
        try (Connection conn = DriverManager.getConnection("jdbc:sqlite:" + db.toAbsolutePath());
             Statement st = conn.createStatement()) {
            st.execute("""
                    CREATE TABLE project (
                      id text PRIMARY KEY,
                      worktree text NOT NULL,
                      vcs text,
                      name text,
                      time_created integer NOT NULL,
                      time_updated integer NOT NULL,
                      sandboxes text NOT NULL
                    )
                    """);
            st.execute("""
                    CREATE TABLE session (
                      id text PRIMARY KEY,
                      project_id text NOT NULL,
                      parent_id text,
                      slug text NOT NULL,
                      directory text NOT NULL,
                      title text NOT NULL,
                      version text NOT NULL,
                      time_created integer NOT NULL,
                      time_updated integer NOT NULL,
                      model text,
                      agent text
                    )
                    """);
            st.execute("""
                    CREATE TABLE message (
                      id text PRIMARY KEY,
                      session_id text NOT NULL,
                      time_created integer NOT NULL,
                      time_updated integer NOT NULL,
                      data text NOT NULL
                    )
                    """);
            st.execute("""
                    CREATE TABLE part (
                      id text PRIMARY KEY,
                      message_id text NOT NULL,
                      session_id text NOT NULL,
                      time_created integer NOT NULL,
                      time_updated integer NOT NULL,
                      data text NOT NULL
                    )
                    """);
            st.execute("INSERT INTO project (id, worktree, vcs, name, time_created, time_updated, sandboxes) "
                    + "VALUES ('proj1', '" + projectPath + "', 'git', null, 1, 2, '[]')");
            st.execute("INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, "
                    + "time_created, time_updated, model, agent) VALUES ('" + sessionId + "', 'proj1', null, 'slug', "
                    + "'" + projectPath + "', 'SQLite OpenCode chat', '1.4.6', 1000, 2000, "
                    + "'{\"id\":\"deepseek-v4-flash-free\",\"providerID\":\"opencode\"}', 'build')");
            // Child session should be filtered from the main list
            st.execute("INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, "
                    + "time_created, time_updated, model, agent) VALUES ('ses_child_1', 'proj1', '" + sessionId
                    + "', 'child', '" + projectPath + "', 'Background child', '1.4.6', 1001, 2001, null, null)");
            st.execute("INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES "
                    + "('" + userMsgId + "', '" + sessionId + "', 1001, 1001, "
                    + "'{\"role\":\"user\",\"time\":{\"created\":1001}}')");
            st.execute("INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES "
                    + "('" + asstMsgId + "', '" + sessionId + "', 1002, 1002, "
                    + "'{\"role\":\"assistant\",\"time\":{\"created\":1002}}')");
            st.execute("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES "
                    + "('prt_u1', '" + userMsgId + "', '" + sessionId + "', 1001, 1001, "
                    + "'{\"type\":\"text\",\"text\":\"你好\"}')");
            st.execute("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES "
                    + "('prt_a1', '" + asstMsgId + "', '" + sessionId + "', 1002, 1002, "
                    + "'{\"type\":\"reasoning\",\"text\":\"think\"}')");
            st.execute("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES "
                    + "('prt_a2', '" + asstMsgId + "', '" + sessionId + "', 1003, 1003, "
                    + "'{\"type\":\"text\",\"text\":\"hello from db\"}')");
            st.execute("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES "
                    + "('prt_a3', '" + asstMsgId + "', '" + sessionId + "', 1004, 1004, "
                    + "'{\"type\":\"tool\",\"callID\":\"call_db\",\"tool\":\"read\","
                    + "\"state\":{\"status\":\"completed\",\"input\":{\"filePath\":\"a.txt\"},\"output\":\"ok\"}}')");
        }

        OpenCodeHistoryReader reader = new OpenCodeHistoryReader(storage, db, new Gson());

        List<OpenCodeHistoryReader.SessionInfo> listed = reader.listSessionsForProject(projectPath);
        assertEquals(1, listed.size());
        assertEquals(sessionId, listed.get(0).sessionId);
        assertEquals("SQLite OpenCode chat", listed.get(0).title);
        assertEquals(2, listed.get(0).messageCount);
        assertEquals("opencode/deepseek-v4-flash-free", listed.get(0).model);
        assertEquals("build", listed.get(0).agent);

        // Parent/child path match: session under project root still matches
        assertEquals(1, reader.listSessionsForProject(projectPath + "/src").size());

        List<JsonObject> messages = reader.getSessionMessages(sessionId, projectPath);
        assertFalse(messages.isEmpty());
        assertEquals("user", messages.get(0).get("type").getAsString());
        String userText = messages.get(0).getAsJsonObject("message")
                .getAsJsonArray("content").get(0).getAsJsonObject().get("text").getAsString();
        assertEquals("你好", userText);

        boolean hasThinking = messages.stream().anyMatch(m ->
                m.has("message")
                        && m.getAsJsonObject("message").has("content")
                        && m.getAsJsonObject("message").getAsJsonArray("content").toString().contains("thinking"));
        boolean hasTool = messages.stream().anyMatch(m ->
                m.has("message")
                        && m.getAsJsonObject("message").has("content")
                        && m.getAsJsonObject("message").getAsJsonArray("content").toString().contains("tool_use"));
        assertTrue(hasThinking);
        assertTrue(hasTool);

        assertTrue(reader.deleteSession(sessionId, projectPath));
        assertTrue(reader.listSessionsForProject(projectPath).isEmpty());
    }

    /**
     * MiMo Code (an OpenCode fork) drops the session.model / session.agent
     * columns and stores the model only on user messages. Listing must survive
     * the missing columns and infer the model from the user message.
     */
    @Test
    public void listsSessionFromForkSchemaWithoutModelColumns() throws Exception {
        Path root = Files.createTempDirectory("mimo-history-db");
        Path storage = root.resolve("storage");
        Files.createDirectories(storage);
        Path db = root.resolve("mimocode.db");

        String sessionId = "ses_fork_mimo1";
        String projectPath = "C:/code/my-app";

        Class.forName("org.sqlite.JDBC");
        try (Connection conn = DriverManager.getConnection("jdbc:sqlite:" + db.toAbsolutePath());
             Statement st = conn.createStatement()) {
            // mimocode.db session schema: no model / agent columns.
            st.execute("""
                    CREATE TABLE session (
                      id text PRIMARY KEY,
                      project_id text NOT NULL,
                      parent_id text,
                      slug text NOT NULL,
                      directory text NOT NULL,
                      title text NOT NULL,
                      version text NOT NULL,
                      time_created integer NOT NULL,
                      time_updated integer NOT NULL
                    )
                    """);
            st.execute("""
                    CREATE TABLE message (
                      id text PRIMARY KEY,
                      session_id text NOT NULL,
                      time_created integer NOT NULL,
                      time_updated integer NOT NULL,
                      data text NOT NULL
                    )
                    """);
            st.execute("INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, "
                    + "time_created, time_updated) VALUES ('" + sessionId + "', 'proj1', null, 'slug', "
                    + "'" + projectPath + "', 'MiMo chat', '0.1.14', 1000, 2000)");
            st.execute("INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES "
                    + "('msg_u1', '" + sessionId + "', 1001, 1001, "
                    + "'{\"role\":\"user\",\"model\":{\"providerID\":\"blueswords\",\"modelID\":\"gpt-5.6-luna\"},\"time\":{\"created\":1001}}')");
        }

        OpenCodeHistoryReader reader = new OpenCodeHistoryReader(storage, db, new Gson());

        List<OpenCodeHistoryReader.SessionInfo> listed = reader.listSessionsForProject(projectPath);
        assertEquals(1, listed.size());
        assertEquals(sessionId, listed.get(0).sessionId);
        assertEquals("MiMo chat", listed.get(0).title);
        assertEquals(1, listed.get(0).messageCount);
        // Model inferred from the user message payload; agent absent on forks.
        assertEquals("blueswords/gpt-5.6-luna", listed.get(0).model);
        assertEquals(null, listed.get(0).agent);
    }
}
