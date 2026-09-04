package com.github.claudecodegui.bridge;

import org.junit.Test;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

public class AiDataProcessGateTest {

    @Test
    public void activeProcessPreventsMigrationFromStarting() throws Exception {
        AiDataProcessGate gate = new AiDataProcessGate();

        try (AiDataProcessGate.ProcessPermit ignored = gate.acquireProcessPermit()) {
            assertNull(gate.tryAcquireMigrationPermit());
        }

        try (AiDataProcessGate.MigrationPermit migration = gate.tryAcquireMigrationPermit()) {
            assertNotNull(migration);
        }
    }

    @Test
    public void processStartCancelsAndWaitsForMigration() throws Exception {
        AiDataProcessGate gate = new AiDataProcessGate();
        AiDataProcessGate.MigrationPermit migration = gate.tryAcquireMigrationPermit();
        assertNotNull(migration);
        ExecutorService executor = Executors.newSingleThreadExecutor();

        try {
            Future<AiDataProcessGate.ProcessPermit> processPermit = executor.submit(gate::acquireProcessPermit);
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(2);
            while (!migration.isCancellationRequested() && System.nanoTime() < deadline) {
                Thread.yield();
            }

            assertTrue(migration.isCancellationRequested());
            assertFalse(processPermit.isDone());
            migration.close();

            try (AiDataProcessGate.ProcessPermit acquired = processPermit.get(2, TimeUnit.SECONDS)) {
                assertNotNull(acquired);
                assertNull(gate.tryAcquireMigrationPermit());
            }
        } finally {
            migration.close();
            executor.shutdownNow();
        }
    }
}
