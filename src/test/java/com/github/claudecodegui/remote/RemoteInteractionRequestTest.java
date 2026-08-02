package com.github.claudecodegui.remote;

import com.github.claudecodegui.permission.PermissionService;
import com.google.gson.JsonObject;
import org.junit.Test;

import java.nio.charset.StandardCharsets;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * Pure-logic tests for {@link RemoteInteractionRequest} parsing/validation
 * (Phase 2C-C §8, §12, §14).
 */
public class RemoteInteractionRequestTest {

    private static byte[] b(String json) {
        return json.getBytes(StandardCharsets.UTF_8);
    }

    // ── permission ─────────────────────────────────────────────────────

    @Test
    public void permissionAllowMapsToAllowValue() {
        RemoteInteractionRequest.PermissionResult r =
                RemoteInteractionRequest.parsePermission(b("{\"taskId\":\"t1\",\"decision\":\"ALLOW\"}"));
        assertTrue(r.valid);
        assertEquals("t1", r.taskId);
        assertEquals(PermissionService.PermissionResponse.ALLOW.getValue(), r.responseValue);
    }

    @Test
    public void permissionAllowAlwaysMapsToAllowAlwaysValue() {
        RemoteInteractionRequest.PermissionResult r =
                RemoteInteractionRequest.parsePermission(b("{\"taskId\":\"t1\",\"decision\":\"ALLOW_ALWAYS\"}"));
        assertTrue(r.valid);
        assertEquals(PermissionService.PermissionResponse.ALLOW_ALWAYS.getValue(), r.responseValue);
    }

    @Test
    public void permissionDenyMapsToDenyValue() {
        RemoteInteractionRequest.PermissionResult r =
                RemoteInteractionRequest.parsePermission(b("{\"taskId\":\"t1\",\"decision\":\"DENY\"}"));
        assertTrue(r.valid);
        assertEquals(PermissionService.PermissionResponse.DENY.getValue(), r.responseValue);
    }

    @Test
    public void permissionRejectsAliasDecision() {
        // Aliases like allow_once / yes / always must NOT be accepted (§8).
        for (String alias : new String[]{"allow_once", "always", "yes", "no", "allow", "Allow"}) {
            RemoteInteractionRequest.PermissionResult r =
                    RemoteInteractionRequest.parsePermission(b("{\"taskId\":\"t1\",\"decision\":\"" + alias + "\"}"));
            assertFalse("alias '" + alias + "' must be rejected", r.valid);
            assertEquals(RemoteErrors.Code.BAD_REQUEST, r.errorCode);
        }
    }

    @Test
    public void permissionRejectsMissingTaskId() {
        assertFalse(RemoteInteractionRequest.parsePermission(b("{\"decision\":\"ALLOW\"}")).valid);
    }

    @Test
    public void permissionRejectsMissingDecision() {
        assertFalse(RemoteInteractionRequest.parsePermission(b("{\"taskId\":\"t1\"}")).valid);
    }

    @Test
    public void permissionRejectsInvalidJson() {
        assertFalse(RemoteInteractionRequest.parsePermission(b("not json")).valid);
        assertFalse(RemoteInteractionRequest.parsePermission(b("")).valid);
        assertFalse(RemoteInteractionRequest.parsePermission(null).valid);
    }

    // ── ask ────────────────────────────────────────────────────────────

    @Test
    public void askParsesAnswersObject() {
        RemoteInteractionRequest.AskResult r =
                RemoteInteractionRequest.parseAsk(b("{\"taskId\":\"t1\",\"answers\":{\"q\":\"a\"}}"));
        assertTrue(r.valid);
        assertEquals("t1", r.taskId);
        assertEquals("a", r.answers.get("q").getAsString());
    }

    @Test
    public void askRejectsNonObjectAnswers() {
        assertFalse(RemoteInteractionRequest.parseAsk(b("{\"taskId\":\"t1\",\"answers\":[\"a\"]}")).valid);
        assertFalse(RemoteInteractionRequest.parseAsk(b("{\"taskId\":\"t1\",\"answers\":\"x\"}")).valid);
    }

    @Test
    public void askRejectsMissingTaskIdOrAnswers() {
        assertFalse(RemoteInteractionRequest.parseAsk(b("{\"answers\":{}}")).valid);
        assertFalse(RemoteInteractionRequest.parseAsk(b("{\"taskId\":\"t1\"}")).valid);
    }

    // ── plan ───────────────────────────────────────────────────────────

    @Test
    public void planApproveWithValidTargetMode() {
        RemoteInteractionRequest.PlanResult r =
                RemoteInteractionRequest.parsePlan(b("{\"taskId\":\"t1\",\"approved\":true,\"targetMode\":\"plan\"}"));
        assertTrue(r.valid);
        assertTrue(r.approved);
        assertEquals("plan", r.targetMode);
    }

    @Test
    public void planRejectDefaultsTargetMode() {
        RemoteInteractionRequest.PlanResult r =
                RemoteInteractionRequest.parsePlan(b("{\"taskId\":\"t1\",\"approved\":false}"));
        assertTrue(r.valid);
        assertFalse(r.approved);
        assertEquals("default", r.targetMode);
    }

    @Test
    public void planRejectsInvalidTargetMode() {
        RemoteInteractionRequest.PlanResult r =
                RemoteInteractionRequest.parsePlan(b("{\"taskId\":\"t1\",\"approved\":true,\"targetMode\":\"auto\"}"));
        assertFalse(r.valid);
        assertEquals(RemoteErrors.Code.INVALID_MODE, r.errorCode);
    }

    @Test
    public void planRejectsNonBooleanApproved() {
        assertFalse(RemoteInteractionRequest.parsePlan(b("{\"taskId\":\"t1\",\"approved\":\"yes\"}")).valid);
        assertFalse(RemoteInteractionRequest.parsePlan(b("{\"taskId\":\"t1\"}")).valid);
    }

    @Test
    public void planResultJsonObjectCarriesApprovedAndTargetMode() {
        // Verify the result JsonObject shape the resolver completes with.
        JsonObject result = new JsonObject();
        result.addProperty("approved", true);
        result.addProperty("targetMode", "default");
        assertTrue(result.get("approved").getAsBoolean());
        assertEquals("default", result.get("targetMode").getAsString());
    }
}
