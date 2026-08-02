package com.github.claudecodegui.remote;

import com.intellij.openapi.diagnostic.Logger;

import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.LongSupplier;

/**
 * Process-wide Remote event infrastructure: the {@link RemoteEventBus}, the
 * shared coalescer-flush scheduler, and a clock.
 *
 * <p>The coalescer scheduler is a single daemon thread ({@code ccgui-remote-coalescer})
 * used by every active task's {@link RemoteDeltaCoalescer} for time-based
 * flushes. It is shut down when the gateway stops.
 */
final class RemoteEventInfra {

    private static final Logger LOG = Logger.getInstance(RemoteEventInfra.class);

    private static final RemoteEventInfra INSTANCE = new RemoteEventInfra();

    private final RemoteEventBus bus = RemoteEventBus.getInstance();
    private final ScheduledExecutorService coalescerExecutor;
    private final RemoteDeltaFlushScheduler coalescerScheduler;
    private final LongSupplier clock = System::currentTimeMillis;

    private RemoteEventInfra() {
        this.coalescerExecutor = Executors.newSingleThreadScheduledExecutor(r -> {
            Thread t = new Thread(r, "ccgui-remote-coalescer");
            t.setDaemon(true);
            return t;
        });
        this.coalescerScheduler = new CoalescerFlushSchedulerImpl(coalescerExecutor);
    }

    static RemoteEventInfra getInstance() {
        return INSTANCE;
    }

    RemoteEventBus bus() {
        return bus;
    }

    RemoteDeltaFlushScheduler coalescerScheduler() {
        return coalescerScheduler;
    }

    LongSupplier clock() {
        return clock;
    }

    void dispose() {
        try {
            coalescerExecutor.shutdownNow();
            coalescerExecutor.awaitTermination(2, TimeUnit.SECONDS);
        } catch (Exception e) {
            LOG.debug("[RemoteGateway] coalescer executor shutdown: " + e.getMessage());
        }
    }

    private static final class CoalescerFlushSchedulerImpl implements RemoteDeltaFlushScheduler {
        private final ScheduledExecutorService executor;
        private final AtomicReference<ScheduledFuture<?>> pending = new AtomicReference<>();

        CoalescerFlushSchedulerImpl(ScheduledExecutorService executor) {
            this.executor = executor;
        }

        @Override
        public void schedule(Runnable runnable, long delayMs) {
            cancel();
            ScheduledFuture<?> f = executor.schedule(runnable, Math.max(0L, delayMs), TimeUnit.MILLISECONDS);
            pending.set(f);
        }

        @Override
        public void cancel() {
            ScheduledFuture<?> f = pending.getAndSet(null);
            if (f != null) {
                f.cancel(false);
            }
        }
    }
}
