package com.github.claudecodegui.bridge;

import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.locks.Condition;
import java.util.concurrent.locks.ReentrantLock;

/** Coordinates AI process starts with exclusive AI data directory operations. */
public final class AiDataProcessGate {

    private static final AiDataProcessGate INSTANCE = new AiDataProcessGate();

    private final ReentrantLock lock = new ReentrantLock(true);
    private final Condition stateChanged = lock.newCondition();
    private int activeProcesses;
    private int waitingProcesses;
    private boolean migrationActive;
    private boolean cancellationRequested;
    private boolean cancellationAllowed;

    public static AiDataProcessGate getInstance() {
        return INSTANCE;
    }

    /** Acquires a process permit, cancelling and waiting for an active migration if necessary. */
    public ProcessPermit acquireProcessPermit() throws InterruptedException {
        lock.lockInterruptibly();
        boolean waiting = false;
        try {
            while (migrationActive) {
                if (!waiting) {
                    waiting = true;
                    waitingProcesses++;
                    if (cancellationAllowed) {
                        cancellationRequested = true;
                    }
                }
                stateChanged.await();
            }
            activeProcesses++;
            return new ProcessPermit(this);
        } finally {
            if (waiting) {
                waitingProcesses--;
            }
            lock.unlock();
        }
    }

    /** Attempts to begin an exclusive migration without waiting for active AI processes. */
    public MigrationPermit tryAcquireMigrationPermit() {
        lock.lock();
        try {
            if (migrationActive || activeProcesses > 0 || waitingProcesses > 0) {
                return null;
            }
            migrationActive = true;
            cancellationRequested = false;
            cancellationAllowed = true;
            return new MigrationPermit(this);
        } finally {
            lock.unlock();
        }
    }

    private boolean isCancellationRequested() {
        lock.lock();
        try {
            return cancellationRequested;
        } finally {
            lock.unlock();
        }
    }

    private boolean beginCommit() {
        lock.lock();
        try {
            if (cancellationRequested) {
                return false;
            }
            cancellationAllowed = false;
            return true;
        } finally {
            lock.unlock();
        }
    }

    private void releaseProcessPermit() {
        lock.lock();
        try {
            activeProcesses--;
            stateChanged.signalAll();
        } finally {
            lock.unlock();
        }
    }

    private void releaseMigrationPermit() {
        lock.lock();
        try {
            migrationActive = false;
            cancellationRequested = false;
            cancellationAllowed = false;
            stateChanged.signalAll();
        } finally {
            lock.unlock();
        }
    }

    public static final class ProcessPermit implements AutoCloseable {
        private final AiDataProcessGate owner;
        private final AtomicBoolean closed = new AtomicBoolean();

        private ProcessPermit(AiDataProcessGate owner) {
            this.owner = owner;
        }

        @Override
        public void close() {
            if (closed.compareAndSet(false, true)) {
                owner.releaseProcessPermit();
            }
        }
    }

    public static final class MigrationPermit implements AutoCloseable {
        private final AiDataProcessGate owner;
        private final AtomicBoolean closed = new AtomicBoolean();

        private MigrationPermit(AiDataProcessGate owner) {
            this.owner = owner;
        }

        public boolean isCancellationRequested() {
            return owner.isCancellationRequested();
        }

        public boolean beginCommit() {
            return owner.beginCommit();
        }

        @Override
        public void close() {
            if (closed.compareAndSet(false, true)) {
                owner.releaseMigrationPermit();
            }
        }
    }
}
