import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { isEditableEventTarget } from '../utils/isEditableEventTarget';
import './PpccApprovalDialog.css';

export interface PpccApprovalBinding {
  runId: string;
  approvalId: string;
  diffSha256: string;
}

export interface PpccApprovalRequest extends PpccApprovalBinding {
  diff: string;
  expiresAt: number;
}

interface PpccApprovalDialogProps {
  isOpen: boolean;
  request: PpccApprovalRequest | null;
  onApprove: (binding: PpccApprovalBinding) => void;
  onReject: (binding: PpccApprovalBinding) => void;
}

function toBinding(request: PpccApprovalRequest): PpccApprovalBinding {
  return {
    runId: request.runId,
    approvalId: request.approvalId,
    diffSha256: request.diffSha256,
  };
}

export default function PpccApprovalDialog({
  isOpen,
  request,
  onApprove,
  onReject,
}: PpccApprovalDialogProps) {
  const { t } = useTranslation();
  const [remainingMs, setRemainingMs] = useState(0);
  const submittedRef = useRef(false);

  useEffect(() => {
    submittedRef.current = false;
    if (!isOpen || !request) return;

    const update = () => setRemainingMs(Math.max(0, request.expiresAt - Date.now()));
    update();
    const timer = window.setInterval(update, 250);
    return () => window.clearInterval(timer);
  }, [isOpen, request?.runId, request?.approvalId, request?.expiresAt]);

  const submit = useCallback((approved: boolean) => {
    if (!request || submittedRef.current) return;
    submittedRef.current = true;
    const binding = toBinding(request);
    if (approved) onApprove(binding);
    else onReject(binding);
  }, [request, onApprove, onReject]);

  useEffect(() => {
    if (!isOpen || !request || submittedRef.current) return;
    if (request.expiresAt > Date.now()) return;
    submit(false);
  }, [isOpen, request, remainingMs, submit]);

  useEffect(() => {
    if (!isOpen || !request) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isEditableEventTarget(event.target)) return;
      if (event.key === 'Escape') submit(false);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, request, submit]);

  const remainingSeconds = useMemo(() => Math.ceil(remainingMs / 1000), [remainingMs]);
  if (!isOpen || !request) return null;

  return createPortal(
    <div className="permission-dialog-overlay ppcc-approval-overlay" role="dialog" aria-modal="true">
      <section className="ppcc-approval-dialog">
        <header className="ppcc-approval-header">
          <div>
            <h3>{t('ppcc.approval.title', 'PPCC 变更审批')}</h3>
            <p>{t('ppcc.approval.subtitle', '请完整核对差异。批准后仍由 PPCC 校验摘要并提交。')}</p>
          </div>
          <span className="ppcc-approval-countdown">
            <span className="codicon codicon-clock" aria-hidden="true" />
            {remainingSeconds}s
          </span>
        </header>

        <dl className="ppcc-approval-meta">
          <div><dt>Run</dt><dd>{request.runId}</dd></div>
          <div><dt>Approval</dt><dd>{request.approvalId}</dd></div>
          <div><dt>SHA-256</dt><dd>{request.diffSha256}</dd></div>
        </dl>

        <pre className="ppcc-approval-diff" tabIndex={0}>{request.diff}</pre>

        <footer className="ppcc-approval-actions">
          <button type="button" className="ppcc-approval-reject" onClick={() => submit(false)}>
            {t('ppcc.approval.reject', '拒绝并回滚')}
          </button>
          <button type="button" className="ppcc-approval-approve" onClick={() => submit(true)}>
            {t('ppcc.approval.approve', '批准变更')}
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
