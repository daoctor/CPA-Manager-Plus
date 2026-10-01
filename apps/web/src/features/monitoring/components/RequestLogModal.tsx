import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { logsApi } from '@/services/api/logs';

const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;

const responseDataToText = async (data: unknown): Promise<string> => {
  if (data instanceof Blob) return data.text();
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (data === null || data === undefined) return '';
  try {
    return JSON.stringify(data, null, 2);
  } catch {
    return String(data);
  }
};

const isNotFoundError = (error: unknown) =>
  Boolean(
    error &&
      typeof error === 'object' &&
      'status' in error &&
      Number((error as { status?: unknown }).status) === 404
  );

type RequestLogContentProps = {
  requestId: string;
};

function RequestLogContent({ requestId }: RequestLogContentProps) {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;

    void logsApi
      .downloadRequestLogById(requestId)
      .then(async (response) => {
        if (cancelled) return;
        if (response.data instanceof Blob && response.data.size > MAX_PREVIEW_BYTES) {
          setError(
            t('monitoring.request_log_too_large', {
              defaultValue: 'Request log is too large to preview.',
            })
          );
          return;
        }
        const nextText = await responseDataToText(response.data);
        if (!cancelled) setText(nextText);
      })
      .catch((loadError: unknown) => {
        if (cancelled) return;
        setError(
          isNotFoundError(loadError)
            ? t('monitoring.request_log_unavailable', {
                defaultValue: 'Request log is no longer available.',
              })
            : loadError instanceof Error
              ? loadError.message
              : t('monitoring.request_log_load_failed', {
                  defaultValue: 'Failed to load request log.',
                })
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [requestId, t]);

  if (loading) {
    return <div>{t('common.loading', { defaultValue: 'Loading...' })}</div>;
  }

  if (error) {
    return <div role="alert">{error}</div>;
  }

  return (
    <pre
      aria-label={t('monitoring.request_log_title', { defaultValue: 'Request Log' })}
      tabIndex={0}
      style={{
        margin: 0,
        maxHeight: '70vh',
        overflow: 'auto',
        padding: 12,
        borderRadius: 8,
        fontSize: 12,
        lineHeight: 1.5,
        whiteSpace: 'pre',
      }}
    >
      {text}
    </pre>
  );
}

type RequestLogModalProps = {
  requestId: string | null;
  onClose: () => void;
};

export function RequestLogModal({ requestId, onClose }: RequestLogModalProps) {
  const { t } = useTranslation();
  const title = requestId
    ? `${t('monitoring.request_log_title', { defaultValue: 'Request Log' })} · ${requestId}`
    : t('monitoring.request_log_title', { defaultValue: 'Request Log' });

  return (
    <Modal
      open={Boolean(requestId)}
      title={title}
      onClose={onClose}
      width="min(1000px, 94vw)"
      footer={
        <Button variant="secondary" onClick={onClose}>
          {t('common.close', { defaultValue: 'Close' })}
        </Button>
      }
    >
      {requestId ? <RequestLogContent key={requestId} requestId={requestId} /> : null}
    </Modal>
  );
}
