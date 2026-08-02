package com.github.claudecodegui.remote;

import org.junit.Before;
import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

/**
 * Pure-logic tests for {@link RemoteInteractionRegistry}.
 */
public class RemoteInteractionRegistryTest {

    @Before
    public void setUp() {
        RemoteInteractionRegistry.getInstance().clearForTest();
    }

    private RemoteInteraction interaction(RemoteInteraction.Type type, String sessionId, String id, String taskId) {
        return new RemoteInteraction(type, id, id, sessionId, "pid", "tab", taskId, 1L);
    }

    @Test
    public void registerAndGet() {
        RemoteInteraction i = interaction(RemoteInteraction.Type.PERMISSION, "s1", "r1", "t1");
        RemoteInteractionRegistry.getInstance().register(i);
        assertEquals(i, RemoteInteractionRegistry.getInstance().get("s1", "r1"));
    }

    @Test
    public void removeRemovesInteraction() {
        RemoteInteractionRegistry.getInstance().register(interaction(RemoteInteraction.Type.PERMISSION, "s1", "r1", "t1"));
        assertNotNull(RemoteInteractionRegistry.getInstance().remove("s1", "r1"));
        assertNull(RemoteInteractionRegistry.getInstance().get("s1", "r1"));
    }

    @Test
    public void sameRequestIdDifferentSessionsDoNotConflict() {
        RemoteInteractionRegistry.getInstance().register(interaction(RemoteInteraction.Type.PERMISSION, "s1", "r1", "t1"));
        RemoteInteractionRegistry.getInstance().register(interaction(RemoteInteraction.Type.PERMISSION, "s2", "r1", "t2"));
        assertEquals("t1", RemoteInteractionRegistry.getInstance().get("s1", "r1").getSourceTaskId());
        assertEquals("t2", RemoteInteractionRegistry.getInstance().get("s2", "r1").getSourceTaskId());
    }

    @Test
    public void getPendingForTaskReturnsOnlyThatTaskInteractions() {
        RemoteInteractionRegistry.getInstance().register(interaction(RemoteInteraction.Type.PERMISSION, "s1", "r1", "t1"));
        RemoteInteractionRegistry.getInstance().register(interaction(RemoteInteraction.Type.QUESTION, "s1", "r2", "t1"));
        RemoteInteractionRegistry.getInstance().register(interaction(RemoteInteraction.Type.PLAN, "s2", "r3", "t2"));
        assertEquals(2, RemoteInteractionRegistry.getInstance().getPendingForTask("t1").size());
        assertEquals(1, RemoteInteractionRegistry.getInstance().getPendingForTask("t2").size());
        assertTrue(RemoteInteractionRegistry.getInstance().hasPending("t1"));
        assertFalse(RemoteInteractionRegistry.getInstance().hasPending("t3"));
    }

    @Test
    public void resolveRemovesActiveInteraction() {
        RemoteInteractionRegistry.getInstance().register(interaction(RemoteInteraction.Type.PERMISSION, "s1", "r1", "t1"));
        RemoteInteractionRegistry.getInstance().remove("s1", "r1");
        assertFalse(RemoteInteractionRegistry.getInstance().hasPending("t1"));
        assertEquals(0, RemoteInteractionRegistry.getInstance().size());
    }

    @Test
    public void typesAreSeparate() {
        RemoteInteractionRegistry.getInstance().register(interaction(RemoteInteraction.Type.PERMISSION, "s1", "r1", "t1"));
        RemoteInteractionRegistry.getInstance().register(interaction(RemoteInteraction.Type.QUESTION, "s1", "r2", "t1"));
        RemoteInteractionRegistry.getInstance().register(interaction(RemoteInteraction.Type.PLAN, "s1", "r3", "t1"));
        assertEquals(3, RemoteInteractionRegistry.getInstance().size());
        assertEquals(RemoteInteraction.Type.PERMISSION, RemoteInteractionRegistry.getInstance().get("s1", "r1").getType());
        assertEquals(RemoteInteraction.Type.QUESTION, RemoteInteractionRegistry.getInstance().get("s1", "r2").getType());
        assertEquals(RemoteInteraction.Type.PLAN, RemoteInteractionRegistry.getInstance().get("s1", "r3").getType());
    }
}
