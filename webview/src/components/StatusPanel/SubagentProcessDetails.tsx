import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { SubagentHistoryResponse } from '../../types';
import { buildSubagentProcessModel, formatSubagentDuration, sanitizeAgentResultText } from './subagentProcess';

interface SubagentProcessDetailsProps {
  agentId?: string;
  totalDurationMs?: number;
  totalTokens?: number;
  totalToolUseCount?: number;
  resultText?: string;
  history?: SubagentHistoryResponse;
  canLoad: boolean;
}

function firstMeaningfulLine(text: string | undefined, t: TFunction): string | undefined {
  if (!text) return undefined;
  const codeFence = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  if (codeFence) return t('subagent.process.reportGenerated');
  return text.split('\n').map((line) => line.trim()).find(Boolean)?.slice(0, 180);
}

const SubagentProcessDetails = memo(function SubagentProcessDetails({
  agentId,
  totalDurationMs,
  totalTokens,
  totalToolUseCount,
  resultText,
  history,
  canLoad,
}: SubagentProcessDetailsProps) {
  const { t } = useTranslation();
  const duration = formatSubagentDuration(totalDurationMs, {
    ms: t('subagent.process.unitMs'),
    s: t('subagent.process.unitS'),
  });
  const process = buildSubagentProcessModel(history);
  // Background launches carry no numeric stats in their toolUseResult —
  // fall back to counting tool calls from the polled sidechain history.
  const derivedToolCount = process.readFiles.length + process.toolCalls.length;
  const toolCount = totalToolUseCount ?? (derivedToolCount > 0 ? derivedToolCount : undefined);
  const stats = [
    duration,
    toolCount != null ? `${toolCount} ${t('subagent.process.unitTools')}` : null,
    totalTokens != null ? `${totalTokens.toLocaleString()} ${t('subagent.process.unitTokens')}` : null,
  ].filter(Boolean).join(' · ');
  const displayResultText = sanitizeAgentResultText(resultText);
  const finalSummary = firstMeaningfulLine(displayResultText, t);
  const hasContent = process.notes.length > 0 || process.readFiles.length > 0 || process.toolCalls.length > 0 || Boolean(finalSummary);

  return (
    <div className="subagent-details subagent-process-card">
      <div className="subagent-process-header">
        <div>
          <div className="subagent-process-title">{t('subagent.process.title')}</div>
          {agentId && <div className="subagent-process-subtitle">{agentId}</div>}
        </div>
        {stats && <div className="subagent-process-stats">{stats}</div>}
      </div>

      {history?.error && <div className="subagent-error">{history.error}</div>}

      {hasContent ? (
        <div className="subagent-process-sections">
          {process.notes.length > 0 && (
            <section className="subagent-process-section">
              <div className="subagent-section-heading">
                <span className="codicon codicon-comment-discussion" />
                {t('subagent.process.thought')}
              </div>
              <div className="subagent-note-card">{process.notes[0]}</div>
            </section>
          )}

          {process.readFiles.length > 0 && (
            <section className="subagent-process-section">
              <div className="subagent-section-heading">
                <span className="codicon codicon-files" />
                {t('subagent.process.filesRead', { count: process.readFiles.length })}
              </div>
              <div className="subagent-file-grid">
                {process.readFiles.map((file) => (
                  <div key={file} className="subagent-file-chip" title={file}>
                    <span className="codicon codicon-file-code" />
                    <span>{file}</span>
                  </div>
                ))}
              </div>
            </section>
          )}

          {process.toolCalls.length > 0 && (
            <section className="subagent-process-section">
              <div className="subagent-section-heading">
                <span className="codicon codicon-tools" />
                {t('subagent.process.otherTools')}
              </div>
              <div className="subagent-tool-list">
                {process.toolCalls.map((tool) => (
                  <div key={tool.id} className="subagent-tool-chip">
                    <span>{tool.name}</span>
                    {tool.detail && <small>{tool.detail}</small>}
                  </div>
                ))}
              </div>
            </section>
          )}

          {finalSummary && (
            <section className="subagent-process-section">
              <div className="subagent-section-heading">
                <span className="codicon codicon-pass-filled" />
                {t('subagent.process.result')}
              </div>
              <div className="subagent-result-card">{finalSummary}</div>
              <details className="subagent-result">
                <summary>{t('subagent.process.showFullOutput')}</summary>
                <pre>{displayResultText}</pre>
              </details>
            </section>
          )}
        </div>
      ) : (
        <div className="subagent-loading-card">
          <span className="codicon codicon-loading" />
          {canLoad ? t('subagent.process.loading') : t('subagent.process.unavailable')}
        </div>
      )}
    </div>
  );
});

export default SubagentProcessDetails;
