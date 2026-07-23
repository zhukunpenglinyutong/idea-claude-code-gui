import { describe, expect, it } from 'vitest';
import { decideWorkflowPollMode, isWorkflowSettled, type WorkflowStatus } from './workflowStatusStore';

describe('decideWorkflowPollMode', () => {
  it('polls once (no interval) for a finished run that has no status yet', () => {
    expect(decideWorkflowPollMode(false, false, false)).toBe('once');
  });

  it('goes idle for a finished run that already has its final status', () => {
    expect(decideWorkflowPollMode(false, true, true)).toBe('idle');
  });

  it('polls at the live cadence while running and unsettled', () => {
    expect(decideWorkflowPollMode(true, false, true)).toBe('active');
  });

  it('keeps WATCHING a running-but-settled run instead of stopping', () => {
    // Regression for the frozen background workflow: a quiet gap between phases
    // (or a long near-silent synthesis phase) makes the run look "settled", but
    // it is still alive. Tearing polling down here left it frozen with no
    // restart path (status only advances on a poll response). It must slow to a
    // watch, never stop, so the next phase / terminal notification is observed.
    expect(decideWorkflowPollMode(true, true, true)).toBe('watch');
  });
});

describe('isWorkflowSettled', () => {
  it('is false without a successful status', () => {
    expect(isWorkflowSettled(undefined)).toBe(false);
    expect(isWorkflowSettled({ success: false } as WorkflowStatus)).toBe(false);
  });

  it('is false while agents are still in flight (done < started)', () => {
    // A long final phase (agent 8 in flight) keeps done < started, so the run
    // is correctly NOT considered settled even if the journal is briefly quiet.
    const status: WorkflowStatus = { success: true, startedCount: 8, doneCount: 7, updatedAtMs: 0 };
    expect(isWorkflowSettled(status)).toBe(false);
  });

  it('is false with zero started agents', () => {
    expect(isWorkflowSettled({ success: true, startedCount: 0, doneCount: 0, updatedAtMs: 0 })).toBe(false);
  });
});
