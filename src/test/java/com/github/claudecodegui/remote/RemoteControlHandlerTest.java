package com.github.claudecodegui.remote;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

/**
 * Pure-logic tests for {@link RemoteControlHandler#validateAnswers} (Phase 2C-C
 * §13). The endpoint HTTP paths require the IntelliJ EDT tab resolver and are
 * covered by manual acceptance; answer-shape validation is pure logic.
 */
public class RemoteControlHandlerTest {

    private static JsonObject questions(String... qa) {
        // qa: pairs of (questionText, "single" | "multi" | "freetext")
        JsonObject root = new JsonObject();
        JsonArray arr = new JsonArray();
        for (int i = 0; i < qa.length; i += 2) {
            JsonObject q = new JsonObject();
            q.addProperty("question", qa[i]);
            String kind = qa[i + 1];
            q.addProperty("multiSelect", "multi".equals(kind));
            JsonArray opts = new JsonArray();
            if (!"freetext".equals(kind)) {
                opts.add("A");
                opts.add("B");
            }
            q.add("options", opts);
            arr.add(q);
        }
        root.add("questions", arr);
        return root;
    }

    private static JsonObject answers(Object... kv) {
        JsonObject o = new JsonObject();
        for (int i = 0; i < kv.length; i += 2) {
            String key = (String) kv[i];
            Object val = kv[i + 1];
            if (val instanceof String) {
                o.addProperty(key, (String) val);
            } else if (val instanceof String[]) {
                JsonArray arr = new JsonArray();
                for (String s : (String[]) val) {
                    arr.add(s);
                }
                o.add(key, arr);
            }
        }
        return o;
    }

    @Test
    public void singleSelectStringAccepted() {
        JsonObject q = questions("请选择方案", "single");
        assertNull(RemoteControlHandler.validateAnswers(q, answers("请选择方案", "A")));
    }

    @Test
    public void multiSelectStringArrayAccepted() {
        JsonObject q = questions("选择多项", "multi");
        assertNull(RemoteControlHandler.validateAnswers(q, answers("选择多项", new String[]{"A", "B"})));
    }

    @Test
    public void customOtherTextAcceptedEvenWhenNotInOptions() {
        // Desktop supports "Other" + textarea; custom text need not be in options.
        JsonObject q = questions("请选择方案", "single");
        assertNull(RemoteControlHandler.validateAnswers(q, answers("请选择方案", "我自己的方案 C")));
    }

    @Test
    public void freeTextOnlyQuestionAccepted() {
        JsonObject q = questions("请输入备注", "freetext");
        assertNull(RemoteControlHandler.validateAnswers(q, answers("请输入备注", "任意文本")));
    }

    @Test
    public void unknownQuestionKeyRejected() {
        JsonObject q = questions("q1", "single");
        assertEquals("Unknown question: q2",
                RemoteControlHandler.validateAnswers(q, answers("q2", "A")));
    }

    @Test
    public void singleSelectWithArrayTypeRejected() {
        JsonObject q = questions("q1", "single");
        assertEquals("Answer for 'q1' must be a string",
                RemoteControlHandler.validateAnswers(q, answers("q1", new String[]{"A"})));
    }

    @Test
    public void multiSelectWithStringTypeRejected() {
        JsonObject q = questions("q1", "multi");
        assertEquals("Answer for 'q1' must be a string array",
                RemoteControlHandler.validateAnswers(q, answers("q1", "A")));
    }

    @Test
    public void customTextOverMaxLengthRejected() {
        JsonObject q = questions("q1", "single");
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < RemoteGatewayLimits.MAX_CUSTOM_INPUT_LENGTH + 1; i++) {
            sb.append('x');
        }
        assertEquals("Answer too long for 'q1'",
                RemoteControlHandler.validateAnswers(q, answers("q1", sb.toString())));
    }

    @Test
    public void totalAnswerCharsCapped() {
        JsonObject q = questions("q1", "single");
        // Each answer is large but under the per-value cap; total exceeds the cap.
        int per = RemoteGatewayLimits.MAX_CUSTOM_INPUT_LENGTH;
        int count = (RemoteGatewayLimits.MAX_TOTAL_ANSWER_CHARS / per) + 2;
        JsonObject answers = new JsonObject();
        for (int i = 0; i < count; i++) {
            // Use distinct question keys so they aren't deduped.
            JsonObject qq = questions("q" + i, "single");
            q = mergeQuestions(q, qq);
            StringBuilder sb = new StringBuilder();
            for (int j = 0; j < per; j++) {
                sb.append('x');
            }
            answers.addProperty("q" + i, sb.toString());
        }
        String err = RemoteControlHandler.validateAnswers(q, answers);
        assertEquals("Total answer size too large", err);
    }

    private static JsonObject mergeQuestions(JsonObject a, JsonObject b) {
        JsonArray arr = a.getAsJsonArray("questions");
        arr.addAll(b.getAsJsonArray("questions"));
        return a;
    }

    @Test
    public void nullAnswersRejected() {
        assertEquals("Missing answers",
                RemoteControlHandler.validateAnswers(questions("q1", "single"), null));
    }
}
