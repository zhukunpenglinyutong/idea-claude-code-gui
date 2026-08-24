package com.github.claudecodegui.provider.gemini;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.Assume;
import org.junit.Test;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.attribute.PosixFilePermissions;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class GeminiPlanUsageServiceTest {

    /** Shape of agy ≥ 1.1.11 `agy -p "/usage" --output-format json` groups[]. */
    private static JsonArray usageGroups() {
        return JsonParser.parseString("""
                [
                  {
                    "name": "Gemini Models",
                    "buckets": [
                      { "id": "gemini-weekly", "window": "weekly", "remaining_fraction": 0.90,
                        "reset_time": "2026-08-11T23:37:11Z" },
                      { "id": "gemini-5h", "window": "5h", "remaining_fraction": 0.75,
                        "reset_time": "2026-08-05T18:15:50Z" }
                    ]
                  },
                  {
                    "name": "Claude and GPT models",
                    "buckets": [
                      { "id": "3p-weekly", "window": "weekly", "remaining_fraction": 0.50,
                        "reset_time": "2026-08-06T02:22:27Z" },
                      { "id": "3p-5h", "window": "5h", "remaining_fraction": 0.25,
                        "reset_time": "2026-08-05T18:55:52Z" }
                    ]
                  }
                ]
                """).getAsJsonArray();
    }

    @Test
    public void normalizeUsageGroups_splitsGeminiAndThirdPartyFamilies() {
        JsonObject out = GeminiPlanUsageService.normalizeUsageGroups(usageGroups());
        assertTrue(out.get("present").getAsBoolean());
        assertEquals("gemini", out.get("provider").getAsString());
        assertEquals("agy-usage-probe", out.get("source").getAsString());
        assertEquals("gemini", out.get("default_family").getAsString());
        // top-level mirrors default (gemini) family — 5h primary
        assertEquals(25.0, out.get("capacity_pct").getAsDouble(), 0.01);
        assertEquals("5h", out.get("period_type").getAsString());

        JsonObject families = out.getAsJsonObject("families");
        assertTrue(families.has("gemini"));
        assertTrue(families.has("third_party"));

        JsonObject gem = families.getAsJsonObject("gemini");
        assertEquals(25.0, gem.get("capacity_pct").getAsDouble(), 0.01);
        JsonArray gemWindows = gem.getAsJsonArray("windows");
        assertEquals(2, gemWindows.size());
        assertEquals("5h", gemWindows.get(0).getAsJsonObject().get("id").getAsString());
        assertEquals(25.0, gemWindows.get(0).getAsJsonObject().get("used_pct").getAsDouble(), 0.01);
        assertEquals("2026-08-05T18:15:50Z",
                gemWindows.get(0).getAsJsonObject().get("reset_at").getAsString());
        assertEquals("7d", gemWindows.get(1).getAsJsonObject().get("id").getAsString());
        assertEquals(10.0, gemWindows.get(1).getAsJsonObject().get("used_pct").getAsDouble(), 0.01);

        JsonObject tp = families.getAsJsonObject("third_party");
        assertEquals(75.0, tp.get("capacity_pct").getAsDouble(), 0.01);
        JsonArray tpWindows = tp.getAsJsonArray("windows");
        assertEquals(2, tpWindows.size());
        assertEquals("5h", tpWindows.get(0).getAsJsonObject().get("id").getAsString());
        assertEquals(75.0, tpWindows.get(0).getAsJsonObject().get("used_pct").getAsDouble(), 0.01);
        assertEquals("7d", tpWindows.get(1).getAsJsonObject().get("id").getAsString());
        assertEquals(50.0, tpWindows.get(1).getAsJsonObject().get("used_pct").getAsDouble(), 0.01);

        // top-level windows also only 5h/7d (gemini family)
        JsonArray topWindows = out.getAsJsonArray("windows");
        assertEquals(2, topWindows.size());
        assertEquals("5h", topWindows.get(0).getAsJsonObject().get("id").getAsString());
        assertEquals("7d", topWindows.get(1).getAsJsonObject().get("id").getAsString());
    }

    @Test
    public void familyFromGroupName_classifiesGeminiVsThirdParty() {
        assertEquals("gemini", GeminiPlanUsageService.familyFromGroupName("Gemini Models"));
        assertEquals("third_party", GeminiPlanUsageService.familyFromGroupName("Claude and GPT models"));
        assertEquals("gemini", GeminiPlanUsageService.familyFromGroupName(null));
        assertEquals("gemini", GeminiPlanUsageService.familyFromGroupName(""));
    }

    @Test
    public void normalizeUsageGroups_emptyIsUnavailable() {
        JsonObject out = GeminiPlanUsageService.normalizeUsageGroups(new JsonArray());
        assertFalse(out.get("present").getAsBoolean());
        assertTrue(out.get("message").getAsString().length() > 0);
    }

    @Test
    public void normalizeUsageGroups_dedupesSamePeriodWithinFamily() {
        // A group emitting the same window twice must collapse to one 5h entry
        JsonArray groups = JsonParser.parseString("""
                [
                  {
                    "name": "Gemini Models",
                    "buckets": [
                      { "id": "gemini-5h", "window": "5h", "remaining_fraction": 0.80 },
                      { "id": "gemini-5h-alt", "window": "5h", "remaining_fraction": 0.60 },
                      { "id": "gemini-weekly", "window": "weekly", "remaining_fraction": 0.50 }
                    ]
                  }
                ]
                """).getAsJsonArray();

        JsonObject out = GeminiPlanUsageService.normalizeUsageGroups(groups);
        assertTrue(out.get("present").getAsBoolean());
        JsonArray windows = out.getAsJsonObject("families")
                .getAsJsonObject("gemini")
                .getAsJsonArray("windows");
        assertEquals(2, windows.size());
        // First 5h bucket wins (0.80 remaining → 20% used)
        assertEquals(20.0, windows.get(0).getAsJsonObject().get("used_pct").getAsDouble(), 0.01);
        assertEquals("7d", windows.get(1).getAsJsonObject().get("id").getAsString());
    }

    @Test
    public void normalizeUsageGroups_skipsUnknownWindowTypes() {
        // monthly / unknown windows are not part of the bar switcher yet
        JsonArray groups = JsonParser.parseString("""
                [
                  {
                    "name": "Gemini Models",
                    "buckets": [
                      { "id": "gemini-monthly", "window": "monthly", "remaining_fraction": 0.30 },
                      { "id": "gemini-5h", "window": "5h", "remaining_fraction": 0.70 }
                    ]
                  }
                ]
                """).getAsJsonArray();

        JsonObject out = GeminiPlanUsageService.normalizeUsageGroups(groups);
        assertTrue(out.get("present").getAsBoolean());
        JsonArray windows = out.getAsJsonObject("families")
                .getAsJsonObject("gemini")
                .getAsJsonArray("windows");
        assertEquals(1, windows.size());
        assertEquals("5h", windows.get(0).getAsJsonObject().get("id").getAsString());
    }

    @Test
    public void fetchViaUsageProbe_timesOutAndDoesNotBlockOnHungProcess() throws Exception {
        // A hung agy must hit waitFor(timeout), get killed, and answer unavailable —
        // the timeout may never depend on the process exiting (drain-after-wait pattern).
        Assume.assumeTrue("requires POSIX /bin/bash", Files.isExecutable(Paths.get("/bin/bash")));
        Path script = Files.createTempFile("agy-hung-probe", ".sh");
        Files.writeString(script, "#!/bin/bash\nsleep 30\n");
        Files.setPosixFilePermissions(script, PosixFilePermissions.fromString("rwxr-xr-x"));
        try {
            long startAt = System.currentTimeMillis();
            JsonObject out = GeminiPlanUsageService.fetchViaUsageProbe(300, script.toAbsolutePath().toString());
            long elapsedMs = System.currentTimeMillis() - startAt;

            assertFalse(out.get("present").getAsBoolean());
            assertTrue("expected timeout message, got: " + out.get("message"),
                    out.get("message").getAsString().contains("timed out"));
            // waitFor must bound the probe, not the child's 30s sleep
            assertTrue("probe must return near the timeout, took " + elapsedMs + "ms", elapsedMs < 10_000);
        } finally {
            Files.deleteIfExists(script);
        }
    }
}
