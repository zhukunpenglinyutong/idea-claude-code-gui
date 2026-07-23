package com.github.claudecodegui.pet;

import com.google.gson.JsonObject;
import org.junit.Test;

import java.awt.Rectangle;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

public class CodexPetFloatingServiceTest {

    @Test
    public void rejectsUnsafeSelectedPetIds() {
        assertEquals("builtin", CodexPetFloatingService.sanitizePetId("../outside.webp"));
        assertEquals("builtin", CodexPetFloatingService.sanitizePetId("C:/outside.webp"));
        assertEquals("builtin", CodexPetFloatingService.sanitizePetId("/outside.webp"));
        assertEquals("safe/spritesheet.webp",
                CodexPetFloatingService.sanitizePetId("safe\\spritesheet.webp"));
    }

    @Test
    public void storesAndRestoresNormalizedFrameCoordinates() {
        double stored = CodexPetFloatingService.storeCoordinate(450, 900);

        assertEquals(0.5d, stored, 0.00001d);
        assertEquals(600, CodexPetFloatingService.restoreCoordinate(stored, 1200));
        assertEquals(0, CodexPetFloatingService.restoreCoordinate(-1.0d, 1200));
        assertEquals(1200, CodexPetFloatingService.restoreCoordinate(2.0d, 1200));
        assertEquals(0.0d, CodexPetFloatingService.storeCoordinate(50, 0), 0.00001d);
    }

    @Test
    public void snapshotsPositionFromProjectStateIndependentlyOfGlobalSettings() {
        CodexPetFloatingService.PetState projectState = new CodexPetFloatingService.PetState();
        projectState.positionX = 0.25d;
        projectState.positionY = 0.75d;
        JsonObject snapshot = new JsonObject();

        CodexPetFloatingService.addProjectPosition(snapshot, projectState);

        assertEquals(0.25d, snapshot.get("positionX").getAsDouble(), 0.00001d);
        assertEquals(0.75d, snapshot.get("positionY").getAsDouble(), 0.00001d);
    }

    @Test
    public void normalizesCatalogDisplayOptions() {
        assertEquals(12, CodexPetFloatingService.normalizeCatalogPageSize(1));
        assertEquals(24, CodexPetFloatingService.normalizeCatalogPageSize(13));
        assertEquals(36, CodexPetFloatingService.normalizeCatalogPageSize(25));
        assertEquals(48, CodexPetFloatingService.normalizeCatalogPageSize(60));
        assertEquals("name_desc", CodexPetFloatingService.normalizeCatalogSort("name_desc"));
        assertEquals("default", CodexPetFloatingService.normalizeCatalogSort("unknown"));
    }

    @Test
    public void normalizesConfiguredSizeWithFrontendBounds() {
        CodexPetFloatingService.PetState small = new CodexPetFloatingService.PetState();
        small.size = 1;
        CodexPetFloatingService.PetState large = new CodexPetFloatingService.PetState();
        large.size = 900;

        assertEquals(32, CodexPetFloatingService.sanitizeState(small).size);
        assertEquals(512, CodexPetFloatingService.sanitizeState(large).size);
    }

    @Test
    public void sanitizesBubbleConfiguration() {
        CodexPetFloatingService.PetState state = new CodexPetFloatingService.PetState();
        state.bubbleDurationSeconds = 99;
        state.bubbleSize = "huge";
        state.bubbleTemplates.put("task_success", List.of("", "done\u0000now"));

        CodexPetFloatingService.PetState sanitized = CodexPetFloatingService.sanitizeState(state);

        assertEquals(20, sanitized.bubbleDurationSeconds);
        assertEquals("medium", sanitized.bubbleSize);
        assertEquals("done now", sanitized.bubbleTemplates.get("task_success").get(0));
    }

    @Test
    public void rendersTaskDurationInBubbleTemplates() throws Exception {
        JsonObject payload = new JsonObject();
        payload.addProperty("durationMs", 12_800);

        assertEquals("Completed in 12.8s", renderBubbleTemplate("Completed in {duration}", payload));
    }

    @Test
    public void keepsBubbleCloseButtonInsideBubbleBounds() throws Exception {
        Rectangle bubble = new Rectangle(12, 24, 260, 82);
        Rectangle close = bubbleCloseBounds(bubble);

        assertTrue(bubble.contains(close));
        assertTrue(close.width >= 16);
        assertTrue(close.height >= 16);
    }

    @Test
    public void activeSourceHeartbeatDoesNotDismissBackgroundBubble() throws Exception {
        CodexPetFloatingService service = createService();
        service.updateActivity("active", "running", true);
        service.showBubble(bubblePayload("background"));

        service.updateActivity("active", "running", true);

        assertEquals("background", activeBubbleSourceId(service));
    }

    @Test
    public void disposingSourceDismissesItsBubble() throws Exception {
        CodexPetFloatingService service = createService();
        service.showBubble(bubblePayload("disposed-source"));
        assertNotNull(activeBubble(service));

        service.updateActivity("disposed-source", "disposed", false);

        assertNull(activeBubble(service));
    }

    @Test
    public void switchingActiveSourceDismissesPreviousSourceBubble() throws Exception {
        CodexPetFloatingService service = createService();
        service.updateActivity("first", "running", true);
        service.showBubble(bubblePayload("first"));

        service.updateActivity("second", "running", true);

        assertNull(activeBubble(service));
    }

    @Test
    public void disposingAnotherSourceKeepsCurrentBubble() throws Exception {
        CodexPetFloatingService service = createService();
        service.showBubble(bubblePayload("current"));

        service.updateActivity("other", "disposed", false);

        assertEquals("current", activeBubbleSourceId(service));
    }

    @Test
    public void sanitizesPetdexNetworkConfigurationWithFrontendBounds() {
        CodexPetFloatingService.PetState state = new CodexPetFloatingService.PetState();
        state.petdexConnectTimeoutSeconds = 500;
        state.petdexRequestTimeoutSeconds = 500;
        state.petdexRetryAttempts = 99;

        CodexPetFloatingService.PetState sanitized = CodexPetFloatingService.sanitizeState(state);

        assertEquals(300, sanitized.petdexConnectTimeoutSeconds);
        assertEquals(300, sanitized.petdexRequestTimeoutSeconds);
        assertEquals(10, sanitized.petdexRetryAttempts);
    }

    @Test
    public void normalizesPetConfigurationScope() {
        CodexPetFloatingService.PetState state = new CodexPetFloatingService.PetState();
        state.scope = "global";
        assertEquals("global", CodexPetFloatingService.sanitizeState(state).scope);
        state.scope = "unknown";
        assertEquals("project", CodexPetFloatingService.sanitizeState(state).scope);
        assertEquals("project", CodexPetFloatingService.normalizeScope(null));
    }

    @Test
    public void activeSourceStateOverridesBackgroundError() throws Exception {
        Map<String, Object> states = new HashMap<>();
        Map<String, Boolean> activeSources = new HashMap<>();
        states.put("background", visualState("ERROR"));
        states.put("active", visualState("RUNNING"));
        activeSources.put("background", false);
        activeSources.put("active", true);

        assertEquals("RUNNING", aggregateVisualStateName(states, activeSources));
    }

    @Test
    public void backgroundStateDoesNotRepresentAnUntrackedActiveTab() throws Exception {
        Map<String, Object> states = new HashMap<>();
        Map<String, Boolean> activeSources = new HashMap<>();
        states.put("background", visualState("RUNNING"));
        activeSources.put("background", false);

        assertEquals("IDLE", aggregateVisualStateName(states, activeSources));
    }

    private static Object visualState(String name) throws Exception {
        Class<?> visualStateClass = Class.forName(
                "com.github.claudecodegui.pet.CodexPetFloatingService$VisualState");
        return Enum.valueOf((Class<Enum>) visualStateClass.asSubclass(Enum.class), name);
    }

    private static String renderBubbleTemplate(String template, JsonObject payload) throws Exception {
        Method method = CodexPetFloatingService.class.getDeclaredMethod(
                "renderBubbleTemplate", String.class, JsonObject.class);
        method.setAccessible(true);
        return (String) method.invoke(null, template, payload);
    }

    private static Rectangle bubbleCloseBounds(Rectangle bubble) throws Exception {
        Method method = CodexPetFloatingService.class.getDeclaredMethod(
                "bubbleCloseBounds", Rectangle.class);
        method.setAccessible(true);
        return (Rectangle) method.invoke(null, bubble);
    }

    private static CodexPetFloatingService createService() {
        com.intellij.openapi.project.Project project = (com.intellij.openapi.project.Project) Proxy.newProxyInstance(
                CodexPetFloatingServiceTest.class.getClassLoader(),
                new Class<?>[]{com.intellij.openapi.project.Project.class},
                (proxy, method, args) -> {
                    if ("isDisposed".equals(method.getName())) {
                        return true;
                    }
                    if ("hashCode".equals(method.getName())) {
                        return System.identityHashCode(proxy);
                    }
                    if ("equals".equals(method.getName())) {
                        return proxy == args[0];
                    }
                    Class<?> returnType = method.getReturnType();
                    if (returnType == boolean.class) {
                        return false;
                    }
                    if (returnType == int.class) {
                        return 0;
                    }
                    if (returnType == long.class) {
                        return 0L;
                    }
                    return null;
                });
        return new CodexPetFloatingService(project);
    }

    private static JsonObject bubblePayload(String sourceId) {
        JsonObject payload = new JsonObject();
        payload.addProperty("event", "running");
        payload.addProperty("sourceId", sourceId);
        return payload;
    }

    private static Object activeBubble(CodexPetFloatingService service) throws Exception {
        Field field = CodexPetFloatingService.class.getDeclaredField("activeBubble");
        field.setAccessible(true);
        return field.get(service);
    }

    private static String activeBubbleSourceId(CodexPetFloatingService service) throws Exception {
        Object bubble = activeBubble(service);
        assertNotNull(bubble);
        Field field = bubble.getClass().getDeclaredField("sourceId");
        field.setAccessible(true);
        return (String) field.get(bubble);
    }

    private static String aggregateVisualStateName(Map<String, Object> states,
                                                   Map<String, Boolean> activeSources) throws Exception {
        Method method = CodexPetFloatingService.class.getDeclaredMethod(
                "aggregateVisualState", Map.class, Map.class);
        method.setAccessible(true);
        return ((Enum<?>) method.invoke(null, states, activeSources)).name();
    }
}
