import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Drawer } from '@/components/ui/Drawer';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { SegmentedTabs, type SegmentedTabItem } from '@/components/ui/SegmentedTabs';
import { logsApi } from '@/services/api/logs';
import {
  parseRequestLogData,
  type ParsedRequestLog,
  type RequestLogAttempt,
  type RequestLogHeader,
  type RequestLogHttpMessage,
  type RequestLogReadableRequest,
  type RequestLogReadableResponse,
  type RequestLogUsage,
} from './requestLogParser';
import styles from './RequestLogModal.module.scss';

type RequestLogTab = 'overview' | 'client' | 'upstream' | 'response';

const TABS: SegmentedTabItem<RequestLogTab>[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'client', label: 'Client Request' },
  { id: 'upstream', label: 'Upstream' },
  { id: 'response', label: 'Final Response' },
];

const isNotFoundError = (error: unknown) =>
  Boolean(
    error &&
      typeof error === 'object' &&
      'status' in error &&
      Number((error as { status?: unknown }).status) === 404
  );

const normalizeTimestamp = (value: string) =>
  value.replace(/(\.\d{3})\d+(?=(?:Z|[+-]\d{2}:\d{2})$)/, '$1');

const durationMs = (attempt: RequestLogAttempt): number | undefined => {
  const startedAt = attempt.request?.meta.Timestamp;
  const endedAt = attempt.response?.meta.Timestamp;
  if (!startedAt || !endedAt) return undefined;
  const start = Date.parse(normalizeTimestamp(startedAt));
  const end = Date.parse(normalizeTimestamp(endedAt));
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : undefined;
};

const formatDuration = (value: number | undefined) => {
  if (value === undefined) return '—';
  return value < 1000 ? Math.round(value) + ' ms' : (value / 1000).toFixed(2) + ' s';
};

const statusLabel = (message?: RequestLogHttpMessage) => message?.meta.Status ?? '—';

function StatCard({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className={styles.statCard}>
      <div className={styles.statLabel}>{label}</div>
      <div className={styles.statValue}>{value ?? '—'}</div>
    </div>
  );
}

function MetaGrid({ values }: { values: Record<string, string> }) {
  const entries = Object.entries(values).filter(([, value]) => value);
  if (entries.length === 0) return null;

  return (
    <div className={styles.metaGrid}>
      {entries.map(([key, value]) => (
        <div className={styles.metaItem} key={key}>
          <span>{key}</span>
          <strong>{value}</strong>
        </div>
      ))}
    </div>
  );
}

function HeadersDetails({ headers }: { headers: RequestLogHeader[] }) {
  if (headers.length === 0) return null;

  return (
    <details className={styles.details} open>
      <summary>Headers ({headers.length})</summary>
      <div className={styles.headers}>
        {headers.map((header, index) => (
          <div className={styles.headerRow} key={header.name + '-' + index}>
            <span>{header.name}</span>
            <code>{header.value}</code>
          </div>
        ))}
      </div>
    </details>
  );
}

function UsageGrid({ usage }: { usage?: RequestLogUsage }) {
  if (!usage) return null;

  return (
    <div className={styles.usageGrid}>
      <StatCard label="Input" value={usage.inputTokens ?? '—'} />
      <StatCard label="Cached" value={usage.cachedTokens ?? '—'} />
      {usage.cacheCreationTokens !== undefined ? (
        <StatCard label="Cache Write" value={usage.cacheCreationTokens} />
      ) : null}
      <StatCard label="Output" value={usage.outputTokens ?? '—'} />
      <StatCard label="Reasoning" value={usage.reasoningTokens ?? '—'} />
      <StatCard label="Total" value={usage.totalTokens ?? '—'} />
    </div>
  );
}

function RequestPreview({ request }: { request?: RequestLogReadableRequest }) {
  if (!request) {
    return <div className={styles.emptyInline}>No readable request body was found.</div>;
  }

  const parameterEntries = Object.entries(request.parameters);

  return (
    <div className={styles.readableBlock}>
      <div className={styles.badges}>
        {request.model ? <span className={styles.badge}>Model · {request.model}</span> : null}
        {request.streaming !== undefined ? (
          <span className={styles.badge}>Streaming · {request.streaming ? 'Yes' : 'No'}</span>
        ) : null}
        {parameterEntries.map(([key, value]) => (
          <span className={styles.badge} key={key}>
            {key} · {value}
          </span>
        ))}
      </div>

      {request.instructions ? (
        <section className={styles.contentSection}>
          <div className={styles.contentLabel}>Instructions</div>
          <div className={styles.readableText}>{request.instructions}</div>
        </section>
      ) : null}

      {request.messages.length > 0 ? (
        <section className={styles.contentSection}>
          <div className={styles.contentLabel}>Messages</div>
          <div className={styles.messages}>
            {request.messages.map((message, index) => (
              <article className={styles.messageBubble} key={message.role + '-' + index}>
                <div className={styles.messageRole}>{message.role}</div>
                <div className={styles.messageText}>{message.content}</div>
              </article>
            ))}
          </div>
        </section>
      ) : (
        <div className={styles.emptyInline}>No human-readable message content was found.</div>
      )}
    </div>
  );
}

function ResponsePreview({ response }: { response?: RequestLogReadableResponse }) {
  if (!response) {
    return <div className={styles.emptyInline}>No readable response body was found.</div>;
  }

  return (
    <div className={styles.readableBlock}>
      <div className={styles.badges}>
        {response.model ? <span className={styles.badge}>Model · {response.model}</span> : null}
        {response.serviceTier ? (
          <span className={styles.badge}>Tier · {response.serviceTier}</span>
        ) : null}
        {response.finishReason ? (
          <span className={styles.badge}>Finish · {response.finishReason}</span>
        ) : null}
      </div>

      {response.reasoning ? (
        <section className={styles.contentSection}>
          <div className={styles.contentLabel}>Reasoning</div>
          <div className={styles.readableText}>{response.reasoning}</div>
        </section>
      ) : null}

      {response.content ? (
        <section className={styles.contentSection}>
          <div className={styles.contentLabel}>Response</div>
          <div className={styles.readableText}>{response.content}</div>
        </section>
      ) : (
        <div className={styles.emptyInline}>No human-readable response text was found.</div>
      )}

      <UsageGrid usage={response.usage} />
    </div>
  );
}

function OverviewTab({ trace }: { trace: ParsedRequestLog }) {
  const firstAttempt = trace.attempts[0];
  const upstreamModel = firstAttempt?.request?.request?.model;
  const finalStatus = statusLabel(trace.response);

  return (
    <div className={styles.tabContent}>
      <div className={styles.summaryGrid}>
        <StatCard label="Method" value={trace.info.Method} />
        <StatCard label="Endpoint" value={trace.info.URL} />
        <StatCard label="CPA Version" value={trace.info.Version} />
        <StatCard label="Status" value={finalStatus} />
        <StatCard label="Requested Model" value={trace.requestedModel} />
        <StatCard label="Upstream Model" value={upstreamModel} />
        <StatCard label="Streaming" value={trace.streaming === undefined ? '—' : trace.streaming ? 'Yes' : 'No'} />
        <StatCard label="Attempts" value={trace.attempts.length} />
      </div>

      <section className={styles.section}>
        <div className={styles.sectionTitle}>Request flow</div>
        <div className={styles.flow}>
          <div className={styles.flowStep}>
            <strong>Client</strong>
            <span>{trace.info.Method || 'POST'} {trace.info.URL || ''}</span>
          </div>
          <span className={styles.flowArrow}>→</span>
          <div className={styles.flowStep}>
            <strong>CPA</strong>
            <span>{trace.info['Downstream Transport'] || 'http'}</span>
          </div>
          <span className={styles.flowArrow}>→</span>
          <div className={styles.flowStep}>
            <strong>Upstream</strong>
            <span>{trace.attempts.length} attempt{trace.attempts.length === 1 ? '' : 's'}</span>
          </div>
          <span className={styles.flowArrow}>→</span>
          <div className={styles.flowStep}>
            <strong>Client</strong>
            <span>Status {finalStatus}</span>
          </div>
        </div>
      </section>

      {trace.attempts.length > 0 ? (
        <section className={styles.section}>
          <div className={styles.sectionTitle}>Attempts</div>
          <div className={styles.attemptSummaryList}>
            {trace.attempts.map((attempt) => (
              <div className={styles.attemptSummary} key={attempt.index}>
                <div>
                  <strong>Attempt {attempt.index}</strong>
                  <span>{attempt.request?.meta['Upstream URL'] || 'Unknown upstream'}</span>
                </div>
                <div className={styles.attemptMetrics}>
                  <span>Status {statusLabel(attempt.response)}</span>
                  <span>{formatDuration(durationMs(attempt))}</span>
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function ClientRequestTab({ trace }: { trace: ParsedRequestLog }) {
  return (
    <div className={styles.tabContent}>
      <section className={styles.section}>
        <div className={styles.sectionTitle}>Request info</div>
        <MetaGrid values={trace.info} />
      </section>
      <section className={styles.section}>
        <div className={styles.sectionTitle}>Client to CPA</div>
        <HeadersDetails headers={trace.requestHeaders} />
        <div className={styles.bodySection}>
          <div className={styles.contentLabel}>Readable request</div>
          <RequestPreview request={trace.clientRequest} />
        </div>
      </section>
    </div>
  );
}

function UpstreamMessage({
  title,
  message,
  response = false,
}: {
  title: string;
  message?: RequestLogHttpMessage;
  response?: boolean;
}) {
  if (!message) return null;

  return (
    <section className={styles.messagePanel}>
      <div className={styles.messageHeader}>
        <strong>{title}</strong>
        {response && message.meta.Status ? (
          <span className={styles.statusBadge}>HTTP {message.meta.Status}</span>
        ) : null}
      </div>
      <MetaGrid values={message.meta} />
      <HeadersDetails headers={message.headers} />
      <div className={styles.bodySection}>
        <div className={styles.contentLabel}>
          {response ? 'Readable response' : 'Readable request'}
        </div>
        {response ? (
          <ResponsePreview response={message.response} />
        ) : (
          <RequestPreview request={message.request} />
        )}
      </div>
    </section>
  );
}

function UpstreamTab({ trace }: { trace: ParsedRequestLog }) {
  if (trace.attempts.length === 0) {
    return <div className={styles.emptyState}>No upstream attempts were found in this log.</div>;
  }

  return (
    <div className={styles.tabContent}>
      {trace.attempts.map((attempt) => (
        <section className={styles.attemptCard} key={attempt.index}>
          <div className={styles.attemptCardHeader}>
            <div>
              <strong>Attempt {attempt.index}</strong>
              <span>{attempt.request?.meta['Upstream URL'] || 'Upstream request'}</span>
            </div>
            <div className={styles.attemptMetrics}>
              <span>Status {statusLabel(attempt.response)}</span>
              <span>{formatDuration(durationMs(attempt))}</span>
            </div>
          </div>
          <UpstreamMessage title="CPA to Upstream" message={attempt.request} />
          <UpstreamMessage title="Upstream to CPA" message={attempt.response} response />
        </section>
      ))}
    </div>
  );
}

function FinalResponseTab({ trace }: { trace: ParsedRequestLog }) {
  if (!trace.response) {
    return <div className={styles.emptyState}>No final client response was found in this log.</div>;
  }

  return (
    <div className={styles.tabContent}>
      <section className={styles.messagePanel}>
        <div className={styles.messageHeader}>
          <strong>CPA to Client</strong>
          {trace.response.meta.Status ? (
            <span className={styles.statusBadge}>HTTP {trace.response.meta.Status}</span>
          ) : null}
        </div>
        <HeadersDetails headers={trace.response.headers} />
        <div className={styles.bodySection}>
          <div className={styles.contentLabel}>Readable response</div>
          <ResponsePreview response={trace.response.response} />
        </div>
      </section>
    </div>
  );
}

type RequestLogViewerProps = {
  requestId: string;
};

function RequestLogViewer({ requestId }: RequestLogViewerProps) {
  const { t } = useTranslation();
  const [trace, setTrace] = useState<ParsedRequestLog | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [activeTab, setActiveTab] = useState<RequestLogTab>('overview');

  useEffect(() => {
    let cancelled = false;

    void logsApi
      .downloadRequestLogById(requestId)
      .then(async (response) => {
        const parsed = await parseRequestLogData(response.data);
        if (!cancelled) setTrace(parsed);
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
    return (
      <div className={styles.loadingState}>
        <LoadingSpinner size={22} />
        <span>{t('common.loading', { defaultValue: 'Loading...' })}</span>
      </div>
    );
  }

  if (error) {
    return <div className={styles.errorState} role="alert">{error}</div>;
  }

  if (!trace) {
    return <div className={styles.emptyState}>Request log is empty.</div>;
  }

  return (
    <div className={styles.viewer}>
      <SegmentedTabs
        items={TABS}
        activeTab={activeTab}
        onChange={setActiveTab}
        ariaLabel="Request log view"
        idBase="request-log"
        className={styles.tabs}
      />

      {activeTab === 'overview' ? <OverviewTab trace={trace} /> : null}
      {activeTab === 'client' ? <ClientRequestTab trace={trace} /> : null}
      {activeTab === 'upstream' ? <UpstreamTab trace={trace} /> : null}
      {activeTab === 'response' ? <FinalResponseTab trace={trace} /> : null}
    </div>
  );
}

type RequestLogModalProps = {
  requestId: string | null;
  onClose: () => void;
};

export function RequestLogModal({ requestId, onClose }: RequestLogModalProps) {
  const { t } = useTranslation();
  const title = requestId
    ? t('monitoring.request_log_title', { defaultValue: 'Request Trace' }) + ' · ' + requestId
    : t('monitoring.request_log_title', { defaultValue: 'Request Trace' });

  return (
    <Drawer
      open={Boolean(requestId)}
      title={title}
      onClose={onClose}
      width="min(1040px, 96vw)"
      footer={
        <Button variant="secondary" onClick={onClose}>
          {t('common.close', { defaultValue: 'Close' })}
        </Button>
      }
    >
      {requestId ? <RequestLogViewer key={requestId} requestId={requestId} /> : null}
    </Drawer>
  );
}
