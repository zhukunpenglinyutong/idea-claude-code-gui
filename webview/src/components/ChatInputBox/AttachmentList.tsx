import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Attachment, AttachmentListProps } from './types';
import { isImageAttachment } from './types';
import { CoDriverIcon } from '../codriverIcons';
import { NativeFileIcon } from '../nativeIcons/NativeFileIcon';
import { getFileIconKind } from '../../utils/fileIconKind';
import { useIsCoDriverTheme } from '../../hooks/useActiveThemeMode';

const ATTACHMENT_PREVIEW_BUTTON_STYLE: React.CSSProperties = {
  background: 'none',
  border: 0,
  padding: 0,
  margin: 0,
  font: 'inherit',
  color: 'inherit',
  cursor: 'pointer',
  display: 'inline-flex',
};

/**
 * AttachmentList - Attachment list component.
 *
 * The CoDriver skin renders a wider, accessible "chip" layout using the bespoke icon pack.
 * Light / dark / system keep the stock 52x52 thumbnail markup so the existing (non-skin)
 * CSS keeps applying correctly — avoiding the squashed-thumbnail regression in normal themes.
 */
export const AttachmentList = ({
  attachments,
  onRemove,
  onPreview,
}: AttachmentListProps) => {
  const { t } = useTranslation();
  const isCoDriver = useIsCoDriverTheme();
  const [previewImage, setPreviewImage] = useState<Attachment | null>(null);

  const handleClick = useCallback((attachment: Attachment) => {
    if (isImageAttachment(attachment)) {
      if (onPreview) {
        onPreview(attachment);
      } else {
        setPreviewImage(attachment);
      }
    }
  }, [onPreview]);

  const handleRemove = useCallback((e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    onRemove?.(id);
  }, [onRemove]);

  const closePreview = useCallback(() => {
    setPreviewImage(null);
  }, []);

  // Stock (light/dark/system) icon mapping — preserved from the base plugin.
  const getStockFileIcon = (mediaType: string): string => {
    if (mediaType.startsWith('text/')) return 'codicon-file-text';
    if (mediaType.includes('json')) return 'codicon-json';
    if (mediaType.includes('javascript') || mediaType.includes('typescript')) return 'codicon-file-code';
    if (mediaType.includes('pdf')) return 'codicon-file-pdf';
    return 'codicon-file';
  };

  const getExtension = (fileName: string): string => {
    const parts = fileName.split('.');
    return parts.length > 1 ? parts[parts.length - 1].toUpperCase() : '';
  };

  if (attachments.length === 0) {
    return null;
  }

  return (
    <>
      {isCoDriver ? (
        <div className="attachment-list" role="list" aria-label={t('chat.attachments', { defaultValue: 'Attachments' })}>
          {attachments.map((attachment) => {
            const imageAttachment = isImageAttachment(attachment);
            const iconName = getFileIconKind(attachment.fileName);

            return (
              <div
                key={attachment.id}
                className={`attachment-item ${imageAttachment ? 'attachment-item-image' : 'attachment-item-file'}`}
                title={attachment.fileName}
                role="listitem"
              >
                {imageAttachment ? (
                  <button
                    type="button"
                    className="attachment-preview-frame attachment-preview-button"
                    style={ATTACHMENT_PREVIEW_BUTTON_STYLE}
                    onClick={() => handleClick(attachment)}
                    aria-label={t('chat.imagePreview')}
                  >
                    <img
                      className="attachment-thumbnail"
                      src={`data:${attachment.mediaType};base64,${attachment.data}`}
                      alt={attachment.fileName}
                    />
                  </button>
                ) : (
                  <span className="attachment-preview-frame">
                    <NativeFileIcon
                      className={`attachment-file-icon attachment-file-icon-${iconName}`}
                      fileName={attachment.fileName}
                      fallback={(
                        <CoDriverIcon
                          name={iconName}
                          size={17}
                          aria-hidden="true"
                        />
                      )}
                    />
                  </span>
                )}

                <span className="attachment-label">{attachment.fileName}</span>

                <button
                  type="button"
                  className="attachment-remove"
                  onClick={(e) => handleRemove(e, attachment.id)}
                  title={t('chat.removeAttachment')}
                  aria-label={t('chat.removeAttachment')}
                >
                  <CoDriverIcon name="x" size={12} />
                </button>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="attachment-list">
          {attachments.map((attachment) => (
            <div
              key={attachment.id}
              className="attachment-item"
              onClick={() => handleClick(attachment)}
              title={attachment.fileName}
            >
              {isImageAttachment(attachment) ? (
                <img
                  className="attachment-thumbnail"
                  src={`data:${attachment.mediaType};base64,${attachment.data}`}
                  alt={attachment.fileName}
                />
              ) : (
                <div className="attachment-file">
                  <span className={`attachment-file-icon codicon ${getStockFileIcon(attachment.mediaType)}`} />
                  <span className="attachment-file-name">
                    {getExtension(attachment.fileName) || attachment.fileName.slice(0, 6)}
                  </span>
                </div>
              )}

              <button
                type="button"
                className="attachment-remove"
                onClick={(e) => handleRemove(e, attachment.id)}
                title={t('chat.removeAttachment')}
                aria-label={t('chat.removeAttachment')}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Image preview dialog (shared across themes) */}
      {previewImage && (
        <div
          className="image-preview-overlay"
          onClick={closePreview}
          onKeyDown={(e) => e.key === 'Escape' && closePreview()}
          tabIndex={0}
        >
          <img
            className="image-preview-content"
            src={`data:${previewImage.mediaType};base64,${previewImage.data}`}
            alt={previewImage.fileName}
            onClick={(e) => e.stopPropagation()}
          />
          <button
            type="button"
            className="image-preview-close"
            onClick={closePreview}
            title={t('chat.closePreview')}
          >
            ×
          </button>
        </div>
      )}
    </>
  );
};

export default AttachmentList;
