import './PpccRunStatus.css';

export type PpccRunPhase = 'running' | 'checking' | 'approval' | 'completed' | 'failed' | 'cancelled';

export interface PpccRunStatusView {
  phase: PpccRunPhase;
  label: string;
}

const STATUS_MAP: Record<string, PpccRunStatusView> = {
  run_started: { phase: 'running', label: '正在分析并执行' },
  assistant_message: { phase: 'running', label: '正在生成结果' },
  tool_started: { phase: 'running', label: '正在执行受控工具' },
  tool_completed: { phase: 'running', label: '工具执行完成' },
  check_started: { phase: 'checking', label: '正在运行检查' },
  check_completed: { phase: 'checking', label: '检查完成' },
  approval_required: { phase: 'approval', label: '等待完整 Diff 审批' },
  run_completed: { phase: 'completed', label: '运行完成' },
  run_failed: { phase: 'failed', label: '运行失败并已回滚' },
  run_cancelled: { phase: 'cancelled', label: '运行已取消并回滚' },
};

export function parsePpccRunStatus(status: string): PpccRunStatusView | null {
  const match = /^PPCC:\s*([a-z_]+)(?:\s|$)/i.exec(status.trim());
  if (!match) return null;
  return STATUS_MAP[match[1].toLowerCase()] ?? { phase: 'running', label: '正在运行' };
}

export default function PpccRunStatus({ status }: { status: string }) {
  const view = parsePpccRunStatus(status);
  if (!view) return null;
  return (
    <div className={`ppcc-run-status ppcc-run-status--${view.phase}`} role="status" aria-live="polite">
      <span className="ppcc-run-status__indicator" aria-hidden="true" />
      <span>{view.label}</span>
    </div>
  );
}
