package com.github.claudecodegui.remote;

import org.junit.Test;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

/**
 * Tests {@link RemoteTabRegistry} via its package-private {@code Object} API so
 * no real {@code ClaudeChatWindow} (which needs the IntelliJ platform) is
 * required. Each test uses a fresh registry instance to stay isolated.
 */
public class RemoteTabRegistryTest {

    private RemoteTabRegistry newRegistry() {
        return new RemoteTabRegistry();
    }

    @Test
    public void sameKeyReturnsStableId() {
        RemoteTabRegistry r = newRegistry();
        Object window = new Object();
        String first = r.idFor(window);
        String second = r.idFor(window);
        assertNotNull(first);
        assertEquals(first, second);
    }

    @Test
    public void differentKeysGetDifferentIds() {
        RemoteTabRegistry r = newRegistry();
        String a = r.idFor(new Object());
        String b = r.idFor(new Object());
        assertNotEquals(a, b);
    }

    @Test
    public void idsAreWellFormedUuids() {
        RemoteTabRegistry r = newRegistry();
        String id = r.idFor(new Object());
        // Throws if not a valid UUID representation.
        UUID.fromString(id);
    }

    @Test
    public void forgetRemovesMapping() {
        RemoteTabRegistry r = newRegistry();
        Object window = new Object();
        String id = r.idFor(window);
        assertEquals(1, r.size());
        r.forget(window);
        assertEquals(0, r.size());
        // A new id is assigned after forget.
        String again = r.idFor(window);
        assertNotEquals(id, again);
    }

    @Test
    public void forgottenIdNotResolvableAsSameValue() {
        RemoteTabRegistry r = newRegistry();
        Object window = new Object();
        String id = r.idFor(window);
        r.forget(window);
        assertFalse(id.equals(r.idFor(window)));
    }

    @Test
    public void nullKeyReturnsNull() {
        RemoteTabRegistry r = newRegistry();
        assertNull(r.idFor(null));
        r.forget(null); // no-op, must not throw
    }

    @Test
    public void concurrentAccessIsSafeAndStable() throws InterruptedException {
        final RemoteTabRegistry r = newRegistry();
        final Object shared = new Object();
        int threads = 16;
        int iterations = 200;
        ExecutorService pool = Executors.newFixedThreadPool(threads);
        CountDownLatch start = new CountDownLatch(1);
        AtomicInteger mismatches = new AtomicInteger();
        List<String> results = Collections.synchronizedList(new ArrayList<>());
        for (int i = 0; i < threads; i++) {
            pool.submit(() -> {
                start.await();
                String first = r.idFor(shared);
                results.add(first);
                for (int j = 0; j < iterations; j++) {
                    if (!first.equals(r.idFor(shared))) {
                        mismatches.incrementAndGet();
                    }
                }
                return null;
            });
        }
        start.countDown();
        pool.shutdown();
        assertTrue(pool.awaitTermination(30, TimeUnit.SECONDS));
        assertEquals(0, mismatches.get());
        // Every thread observed the same id.
        assertEquals(1, new HashSet<>(results).size());
    }
}
