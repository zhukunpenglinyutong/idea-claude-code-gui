import { describe, expect, it } from 'vitest';
import { parsePpccRunStatus } from './PpccRunStatus';

describe('parsePpccRunStatus', () => {
  it('maps structured PPCC status text into a stable display state', () => {
    expect(parsePpccRunStatus('PPCC: run_started')).toMatchObject({ phase: 'running', label: '正在分析并执行' });
    expect(parsePpccRunStatus('PPCC: check_started')).toMatchObject({ phase: 'checking', label: '正在运行检查' });
    expect(parsePpccRunStatus('PPCC: approval_required')).toMatchObject({ phase: 'approval', label: '等待完整 Diff 审批' });
    expect(parsePpccRunStatus('PPCC: run_completed')).toMatchObject({ phase: 'completed', label: '运行完成' });
  });

  it('ignores non-PPCC status text', () => {
    expect(parsePpccRunStatus('ready')).toBeNull();
  });
});
