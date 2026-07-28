import { useEffect, useState, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { formatCountdown } from '../utils/helpers';
import { useDialogCountdownTimeout } from '../hooks/useDialogCountdownTimeout';
import { DEFAULT_PERMISSION_DIALOG_TIMEOUT_SECONDS } from '../utils/permissionDialogTimeout';
import { isEditableEventTarget } from '../utils/isEditableEventTarget';
import './AskUserQuestionDialog.css';

// Special marker to identify the "Other" option
const OTHER_OPTION_MARKER = '__OTHER__';

// Maximum length limit for custom input
const MAX_CUSTOM_INPUT_LENGTH = 2000;

export interface QuestionOption {
  label: string;
  description: string;
}

export interface Question {
  question: string;
  header: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

export interface AskUserQuestionRequest {
  requestId: string;
  toolName: string;
  questions: Question[];
  provider?: 'claude' | 'codex';
}

interface AskUserQuestionDialogProps {
  isOpen: boolean;
  request: AskUserQuestionRequest | null;
  onSubmit: (requestId: string, answers: Record<string, string | string[]>) => void;
  onCancel: (requestId: string) => void;
  timeoutSeconds?: number;
}

function normalizeQuestion(raw: any): Question | null {
  if (!raw || typeof raw !== 'object') return null;
  const questionText = typeof raw.question === 'string' ? raw.question : (typeof raw.text === 'string' ? raw.text : '');
  const header = typeof raw.header === 'string' ? raw.header : '';
  const multiSelect = typeof raw.multiSelect === 'boolean' ? raw.multiSelect : false;
  const rawOptions = Array.isArray(raw.options) ? raw.options : (Array.isArray(raw.choices) ? raw.choices : []);
  const options: QuestionOption[] = rawOptions
    .map((opt: any): QuestionOption | null => {
      if (typeof opt === 'string') return { label: opt, description: '' };
      if (!opt || typeof opt !== 'object') return null;
      const label = typeof opt.label === 'string' ? opt.label : (typeof opt.value === 'string' ? opt.value : '');
      const description = typeof opt.description === 'string' ? opt.description : '';
      if (!label) return null;
      return { label, description };
    })
    .filter(Boolean) as QuestionOption[];
  if (!questionText) return null;
  return { question: questionText, header, options, multiSelect };
}

const AskUserQuestionDialog = ({
  isOpen,
  request,
  onSubmit,
  onCancel,
  timeoutSeconds = DEFAULT_PERMISSION_DIALOG_TIMEOUT_SECONDS,
}: AskUserQuestionDialogProps) => {
  const { t } = useTranslation();
  const [answers, setAnswers] = useState<Record<string, Set<string>>>({});
  const [customInputs, setCustomInputs] = useState<Record<string, string>>({});
  const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0);
  const [isCollapsed, setIsCollapsed] = useState(false);

  const customInputRef = useRef<HTMLTextAreaElement>(null);
  const handleTimeout = useCallback(() => {
    if (request) {
      onCancel(request.requestId);
    }
  }, [request, onCancel]);

  const { remainingSeconds, isTimeWarning, markSubmitted } = useDialogCountdownTimeout({
    isOpen,
    requestKey: request?.requestId,
    timeoutSeconds,
    onTimeout: handleTimeout,
  });
  const normalizedQuestions = (Array.isArray(request?.questions) ? request!.questions : [])
    .map(normalizeQuestion)
    .filter(Boolean) as Question[];
  const isCodexRequest = request?.provider === 'codex' || request?.toolName === 'request_user_input';
  const dialogTitle = isCodexRequest
    ? t('askUserQuestion.codexTitle', 'Codex 有一些问题想问你')
    : t('askUserQuestion.title', 'Claude 有一些问题想问你');

  const handleCancel = useCallback(() => {
    if (request && markSubmitted()) {
      onCancel(request.requestId);
    }
  }, [request, markSubmitted, onCancel]);

  useEffect(() => {
    if (isOpen && request) {
      const questions = (Array.isArray(request.questions) ? request.questions : [])
        .map(normalizeQuestion)
        .filter(Boolean) as Question[];

      const initialAnswers: Record<string, Set<string>> = {};
      const initialCustomInputs: Record<string, string> = {};
      questions.forEach((q) => {
        initialAnswers[q.question] = new Set<string>();
        initialCustomInputs[q.question] = '';
      });
      setAnswers(initialAnswers);
      setCustomInputs(initialCustomInputs);
      setCurrentQuestionIndex(0);
      setIsCollapsed(false);
    }
  }, [isOpen, request?.requestId]);

  // Keyboard event handling - separate effect to avoid frequent listener registration/removal
  useEffect(() => {
    if (!isOpen || !request) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (isEditableEventTarget(e.target)) {
        return;
      }

      if (e.key === 'Escape') {
        handleCancel();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, request, handleCancel]);

  if (!isOpen || !request) {
    return null;
  }

  if (normalizedQuestions.length === 0) {
    return (
      <div className="permission-dialog-overlay">
        <div className="ask-user-question-dialog">
          <h3 className="ask-user-question-dialog-title">
            {dialogTitle}
          </h3>
          <p className="question-text">
            {t('askUserQuestion.invalidFormat', '问题数据格式不支持，请取消后重试。')}
          </p>
          <div className="ask-user-question-dialog-actions">
            <button className="action-button secondary" onClick={handleCancel}>
              {t('askUserQuestion.cancel', '取消')}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // FIX: Ensure currentQuestionIndex does not go out of bounds
  // When request changes cause normalizedQuestions length to decrease,
  // currentQuestionIndex may still hold the old value (since useEffect state updates are async)
  const safeQuestionIndex = Math.max(0, Math.min(currentQuestionIndex, normalizedQuestions.length - 1));
  const currentQuestion = normalizedQuestions[safeQuestionIndex];

  // FIX: Additional defensive check to prevent currentQuestion being undefined in edge cases
  // This can happen during React concurrent rendering or state update timing issues
  if (!currentQuestion) {
    return (
      <div className="permission-dialog-overlay">
        <div className="ask-user-question-dialog">
          <h3 className="ask-user-question-dialog-title">
            {dialogTitle}
          </h3>
          <p className="question-text">
            {t('askUserQuestion.loading', '正在加载问题...')}
          </p>
          <div className="ask-user-question-dialog-actions">
            <button className="action-button secondary" onClick={handleCancel}>
              {t('askUserQuestion.cancel', '取消')}
            </button>
          </div>
        </div>
      </div>
    );
  }

  const isLastQuestion = safeQuestionIndex === normalizedQuestions.length - 1;
  const currentAnswerSet = answers[currentQuestion.question] || new Set<string>();
  const currentCustomInput = customInputs[currentQuestion.question] || '';
  const isOtherSelected = currentAnswerSet.has(OTHER_OPTION_MARKER);

  const handleOptionToggle = (label: string) => {
    setAnswers((prev) => {
      const newAnswers = { ...prev };
      const currentSet = new Set(newAnswers[currentQuestion.question] || []);

      if (currentQuestion.multiSelect) {
        // Multi-select mode: toggle option
        if (currentSet.has(label)) {
          currentSet.delete(label);
        } else {
          currentSet.add(label);
        }
      } else {
        // Single-select mode: clear and set new option
        currentSet.clear();
        currentSet.add(label);
      }

      newAnswers[currentQuestion.question] = currentSet;
      return newAnswers;
    });

    // Auto-focus the input field when "Other" option is selected
    if (label === OTHER_OPTION_MARKER) {
      setTimeout(() => {
        customInputRef.current?.focus();
      }, 0);
    }
  };

  const handleCustomInputChange = (value: string) => {
    // Limit input length to prevent excessively long input
    const sanitizedValue = value.slice(0, MAX_CUSTOM_INPUT_LENGTH);
    setCustomInputs((prev) => ({
      ...prev,
      [currentQuestion.question]: sanitizedValue,
    }));
  };

  const handleNext = () => {
    if (isLastQuestion) {
      handleSubmitFinal();
    } else {
      setCurrentQuestionIndex((prev) => prev + 1);
    }
  };

  const handleBack = () => {
    if (safeQuestionIndex > 0) {
      setCurrentQuestionIndex((prev) => Math.max(0, prev - 1));
    }
  };

  const handleSubmitFinal = () => {
    if (!markSubmitted()) return;

    const formattedAnswers: Record<string, string | string[]> = {};
    normalizedQuestions.forEach((q) => {
      const selectedSet = answers[q.question] || new Set<string>();
      const customText = customInputs[q.question] || '';

      // Filter out the "Other" marker, get actually selected options
      const selectedLabels = Array.from(selectedSet).filter(label => label !== OTHER_OPTION_MARKER);

      // If "Other" is selected and has custom input, add the custom input to answers
      if (selectedSet.has(OTHER_OPTION_MARKER) && customText.trim()) {
        selectedLabels.push(customText.trim());
      }

      if (selectedLabels.length > 0) {
        formattedAnswers[q.question] = q.multiSelect ? selectedLabels : selectedLabels[0]!;
      }
    });

    onSubmit(request.requestId, formattedAnswers);
  };

  // Check if we can proceed:
  // 1. A regular option (not "Other") is selected
  // 2. Or "Other" is selected with valid custom input
  const hasRegularSelection = Array.from(currentAnswerSet).some(label => label !== OTHER_OPTION_MARKER);
  const hasValidCustomInput = isOtherSelected && currentCustomInput.trim().length > 0;
  const canProceed = hasRegularSelection || hasValidCustomInput;

  return (
    <div className={`permission-dialog-overlay ${isCollapsed ? 'collapsed-mode' : ''}`}>
      <div className={`ask-user-question-dialog ${isCollapsed ? 'collapsed' : 'expanded'} ${isTimeWarning ? 'time-warning' : ''}`}>
        {/* Header area - with collapse/expand button */}
        <div className="ask-user-question-dialog-header">
          <h3 className="ask-user-question-dialog-title">
            {dialogTitle}
          </h3>
          <button
            className="collapse-toggle-button"
            onClick={() => setIsCollapsed(!isCollapsed)}
            title={isCollapsed ? t('askUserQuestion.expand', '展开') : t('askUserQuestion.collapse', '收起')}
            aria-label={isCollapsed ? t('askUserQuestion.expand', '展开') : t('askUserQuestion.collapse', '收起')}
            aria-expanded={!isCollapsed}
          >
            <span className={`codicon codicon-chevron-${isCollapsed ? 'up' : 'down'}`} />
          </button>
        </div>

        {/* Timeout warning notice */}
        {isTimeWarning && !isCollapsed && (
          <div className="timeout-warning-banner">
            <span className="codicon codicon-warning" />
            <span>{t('askUserQuestion.timeoutWarning', '请尽快回答，对话框将在 {{seconds}} 秒后自动关闭', { seconds: remainingSeconds })}</span>
          </div>
        )}

        {/* Brief hint in collapsed state */}
        {isCollapsed ? (
          <div className="collapsed-hint">
            <span className="collapsed-progress">
              {t('askUserQuestion.progress', '问题 {{current}} / {{total}}', {
                current: safeQuestionIndex + 1,
                total: normalizedQuestions.length,
              })}
            </span>
            {isTimeWarning && (
              <span className="collapsed-timer warning">
                <span className="codicon codicon-warning" />
                {formatCountdown(remainingSeconds)}
              </span>
            )}
            <button
              className="action-button primary expand-button"
              onClick={() => setIsCollapsed(false)}
            >
              {t('askUserQuestion.clickToAnswer', '点击回答')}
            </button>
          </div>
        ) : (
          <>
            <div className="ask-user-question-dialog-progress-row">
              <span className="ask-user-question-dialog-progress">
                {t('askUserQuestion.progress', '问题 {{current}} / {{total}}', {
                  current: safeQuestionIndex + 1,
                  total: normalizedQuestions.length,
                })}
              </span>
              {/* Countdown display */}
              <span className={`countdown-timer ${isTimeWarning ? 'warning' : ''}`}>
                <span className="codicon codicon-clock" />
                <span className="countdown-time">{formatCountdown(remainingSeconds)}</span>
              </span>
            </div>

            {/* Question area */}
            <div className="ask-user-question-dialog-question">
              <div className="question-header">
                <span className="question-tag">{currentQuestion.header}</span>
              </div>
              <p className="question-text">{currentQuestion.question}</p>

              {/* Options list */}
              <div className="question-options">
                {currentQuestion.options.map((option) => {
                  const isSelected = currentAnswerSet.has(option.label);
                  return (
                    <button
                      key={option.label}
                      className={`question-option ${isSelected ? 'selected' : ''}`}
                      onClick={() => handleOptionToggle(option.label)}
                    >
                      <div className="option-checkbox">
                        {currentQuestion.multiSelect ? (
                          <span className={`codicon codicon-${isSelected ? 'check' : 'blank'}`} />
                        ) : (
                          <span className={`codicon codicon-${isSelected ? 'circle-filled' : 'circle-outline'}`} />
                        )}
                      </div>
                      <div className="option-content">
                        <div className="option-label">{option.label}</div>
                        <div className="option-description">{option.description}</div>
                      </div>
                    </button>
                  );
                })}

                {/* "Other" option - allows custom user input */}
                <button
                  className={`question-option other-option ${isOtherSelected ? 'selected' : ''}`}
                  onClick={() => handleOptionToggle(OTHER_OPTION_MARKER)}
                >
                  <div className="option-checkbox">
                    {currentQuestion.multiSelect ? (
                      <span className={`codicon codicon-${isOtherSelected ? 'check' : 'blank'}`} />
                    ) : (
                      <span className={`codicon codicon-${isOtherSelected ? 'circle-filled' : 'circle-outline'}`} />
                    )}
                  </div>
                  <div className="option-content">
                    <div className="option-label">{t('askUserQuestion.otherOption', '其他')}</div>
                    <div className="option-description">{t('askUserQuestion.otherOptionDesc', '输入自定义答案')}</div>
                  </div>
                </button>
              </div>

              {/* Custom input field - only shown when "Other" is selected */}
              {isOtherSelected && (
                <div className="custom-input-container">
                  <textarea
                    ref={customInputRef}
                    className="custom-input"
                    value={currentCustomInput}
                    onChange={(e) => handleCustomInputChange(e.target.value)}
                    placeholder={t('askUserQuestion.customInputPlaceholder', '请输入您的答案...')}
                    rows={3}
                    maxLength={MAX_CUSTOM_INPUT_LENGTH}
                  />
                </div>
              )}

              {/* Hint text */}
              {currentQuestion.multiSelect && (
                <p className="question-hint">
                  {t('askUserQuestion.multiSelectHint', '可以选择多个选项')}
                </p>
              )}
            </div>

            {/* Action buttons */}
            <div className="ask-user-question-dialog-actions">
              <button
                className="action-button secondary"
                onClick={handleCancel}
              >
                {t('askUserQuestion.cancel', '取消')}
              </button>

              <div className="action-buttons-right">
                {safeQuestionIndex > 0 && (
                  <button
                    className="action-button secondary"
                    onClick={handleBack}
                  >
                    {t('askUserQuestion.back', '上一步')}
                  </button>
                )}

                <button
                  className={`action-button primary ${!canProceed ? 'disabled' : ''}`}
                  onClick={handleNext}
                  disabled={!canProceed}
                >
                  {isLastQuestion
                    ? t('askUserQuestion.submit', '提交')
                    : t('askUserQuestion.next', '下一步')}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default AskUserQuestionDialog;
