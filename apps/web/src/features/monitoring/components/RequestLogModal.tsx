import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Drawer } from '@/components/ui/Drawer';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { SegmentedTabs, type SegmentedTabItem } from '@/components/ui/SegmentedTabs';
import { logsApi } from '@/services/api/logs';
import {
  parseRequestLog,
  type ParsedRequestLog,
  type RequestLogAttempt,
  type RequestLogHeader,
  type RequestLogHttpMessage,
  type RequestLogStreamSummary,
  type RequestLogUsage,
} from './requestLogParser';
import styles from './RequestLogModal.module.scss';

const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;

type RequestLogTab = 'overview' | 'client' | 'upstream' | 'response' | 'timeline' | 'raw';

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

const readJsonString = (value: unknown, key: string): string | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === 'string' && candidate ? candidate : undefined;
};

const tryParseBody = (body: string): unknown | undefined => {
  try {
    return body.trim() ? (JSON.parse(body) as unknown) : undefined;
  } catch {
    return undefined;
  }
};

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
      <div className={styles.statValue}>{value || '—'}</div>
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

function CodeBlock({
  children,
  raw = false,
  empty = 'No body',
}: {
  children: string;
  raw?: boolean;
  empty?: string;
}) {
  return (
    <pre className={raw ? styles.rawCode : styles.codeBlock} tabIndex={0}>
      {children || empty}
    </pre>
  );
}

function HeadersDetails({ headers }: { headers: RequestLogHeader[] }) {
  if (headers.length === 0) return null;

  return (
    <details className={styles.details}>
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
      <StatCard label="Output" value={usage.outputTokens ?? '—'} />
      <StatCard label="Reasoning" value={usage.reasoningTokens ?? '—'} />
      <StatCard label="Total" value={usage.totalTokens ?? '—'} />
    </div>
  );
}

function StreamPreview({
  stream,
  fallback,
}: {
  stream?: RequestLogStreamSummary;
  fallback: string;
}) {
  if (!stream) return <CodeBlock>{fallback}</CodeBlock>;

  const hasReadableContent = Boolean(stream.reasoning || stream.content);
  return (
    <div className={styles.streamPreview}>
      <div className={styles.badges}>
        {stream.model ? <span className={styles.badge}>Model · {stream.model}</span> : null}
        {stream.serviceTier ? (
          <span className={styles.badge}>Tier · {stream.serviceTier}</span>
        ) : null}
        {stream.finishReason ? (
          <span className={styles.badge}>Finish · {stream.finishReason}</span>
        ) : null}
        <span className={styles.badge}>Streaming</span>
      </div>

      {stream.reasoning ? (
        <section className={styles.contentSection}>
          <div className={styles.contentLabel}>Reasoning</div>
          <div className={styles.readableText}>{stream.reasoning}</div>
        </section>
      ) : null}

      {stream.content ? (
        <section className={styles.contentSection}>
          <div className={styles.contentLabel}>Assistant</div>
          <div className={styles.readableText}>{stream.content}</div>
        </section>
      ) : null}

      <UsageGrid usage={stream.usage} />

      {!hasReadableContent ? <CodeBlock>{fallback}</CodeBlock> : null}
    </div>
  );
}

function OverviewTab({ trace }: { trace: ParsedRequestLog }) {
  const firstAttempt = trace.attempts[0];
  const upstreamBody = firstAttempt?.request ? tryParseBody(firstAttempt.request.body) : undefined;
  const upstreamModel = readJsonString(upstreamBody, 'model');
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
        <div className={styles.sectionTitle}>Body</div>
        <CodeBlock>{trace.requestBodyPretty}</CodeBlock>
      </section>
      <HeadersDetails headers={trace.requestHeaders} />
    </div>
  );
}

function MessagePanel({
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
      <div className={styles.messageBody}>
        <div className={styles.contentLabel}>Body</div>
        {response ? (
          <StreamPreview stream={message.stream} fallback={message.prettyBody} />
        ) : (
          <CodeBlock>{message.prettyBody}</CodeBlock>
        )}
      </div>
      <HeadersDetails headers={message.headers} />
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
          <MessagePanel title="Upstream request" message={attempt.request} />
          <MessagePanel title="Upstream response" message={attempt.response} response />
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
      <MessagePanel title="CPA → Client" message={trace.response} response />
    </div>
  );
}

function TimelineGroup({ title, stream }: { title: string; stream?: RequestLogStreamSummary }) {
  if (!stream || stream.timeline.length === 0) return null;

  return (
    <section className={styles.section}>
      <div className={styles.sectionTitle}>{title}</div>
      <div className={styles.timeline}>
        {stream.timeline.map((item, index) => (
          <div className={styles.timelineItem} key={item.event + '-' + index}>
            <span className={styles.timelineIndex}>
              {item.sequenceNumber !== undefined ? '#' + item.sequenceNumber : '•'}
            </span>
            <div>
              <strong>{item.event}</strong>
              {item.detail ? <span>{item.detail}</span> : null}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function TimelineTab({ trace }: { trace: ParsedRequestLog }) {
  const hasTimeline =
    trace.attempts.some((attempt) => Boolean(attempt.response?.stream?.timeline.length)) ||
    Boolean(trace.response?.stream?.timeline.length);

  if (!hasTimeline) {
    return <div className={styles.emptyState}>No streaming event timeline was found.</div>;
  }

  return (
    <div className={styles.tabContent}>
      {trace.attempts.map((attempt) => (
        <TimelineGroup
          key={attempt.index}
          title={'Attempt ' + attempt.index + ' · upstream stream'}
          stream={attempt.response?.stream}
        />
      ))}
      <TimelineGroup title="Final client stream" stream={trace.response?.stream} />
    </div>
  );
}

type RequestLogViewerProps = {
  requestId: string;
};

function RequestLogViewer({ requestId }: RequestLogViewerProps) {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [activeTab, setActiveTab] = useState<RequestLogTab>('overview');

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

  const trace = useMemo(() => (text ? parseRequestLog(text) : null), [text]);
  const tabs = useMemo<SegmentedTabItem<RequestLogTab>[]>(
    () => [
      { id: 'overview', label: 'Overview' },
      { id: 'client', label: 'Client Request' },
      { id: 'upstream', label: 'Upstream' },
      { id: 'response', label: 'Final Response' },
      { id: 'timeline', label: 'Timeline' },
      { id: 'raw', label: 'Raw' },
    ],
    []
  );

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
        items={tabs}
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
      {activeTab === 'timeline' ? <TimelineTab trace={trace} /> : null}
      {activeTab === 'raw' ? <CodeBlock raw>{trace.raw}</CodeBlock> : null}
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
