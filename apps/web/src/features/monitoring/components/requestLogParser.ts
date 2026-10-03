type JsonRecord = Record<string, unknown>;

export type RequestLogHeader = {
  name: string;
  value: string;
};

export type RequestLogUsage = {
  inputTokens?: number;
  cachedTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
};

export type RequestLogTimelineItem = {
  event: string;
  sequenceNumber?: number;
  detail?: string;
};

export type RequestLogStreamSummary = {
  model?: string;
  serviceTier?: string;
  reasoning: string;
  content: string;
  finishReason?: string;
  usage?: RequestLogUsage;
  timeline: RequestLogTimelineItem[];
};

export type RequestLogHttpMessage = {
  meta: Record<string, string>;
  headers: RequestLogHeader[];
  body: string;
  prettyBody: string;
  stream?: RequestLogStreamSummary;
};

export type RequestLogAttempt = {
  index: number;
  request?: RequestLogHttpMessage;
  response?: RequestLogHttpMessage;
};

export type ParsedRequestLog = {
  info: Record<string, string>;
  requestHeaders: RequestLogHeader[];
  requestBody: string;
  requestBodyPretty: string;
  requestBodyJson?: unknown;
  requestedModel?: string;
  streaming?: boolean;
  attempts: RequestLogAttempt[];
  response?: RequestLogHttpMessage;
  raw: string;
};

const asRecord = (value: unknown): JsonRecord | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;

const readString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

const readNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const firstDefinedNumber = (...values: unknown[]): number | undefined => {
  for (const value of values) {
    const numberValue = readNumber(value);
    if (numberValue !== undefined) return numberValue;
  }
  return undefined;
};

const tryParseJson = (value: string): unknown | undefined => {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
};

export const prettyPrintRequestLogBody = (value: string): string => {
  const parsed = tryParseJson(value);
  return parsed === undefined ? value : JSON.stringify(parsed, null, 2);
};

const parseKeyValueLines = (value: string): Record<string, string> => {
  const result: Record<string, string> = {};
  for (const line of value.split('\n')) {
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const entryValue = line.slice(separator + 1).trim();
    if (key) result[key] = entryValue;
  }
  return result;
};

const parseHeaderLines = (value: string): RequestLogHeader[] => {
  const headers: RequestLogHeader[] = [];
  for (const line of value.split('\n')) {
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    const name = line.slice(0, separator).trim();
    const headerValue = line.slice(separator + 1).trim();
    if (name) headers.push({ name, value: headerValue });
  }
  return headers;
};

const normalizeUsage = (value: unknown): RequestLogUsage | undefined => {
  const usage = asRecord(value);
  if (!usage) return undefined;

  const inputDetails = asRecord(usage.input_tokens_details) ?? asRecord(usage.prompt_tokens_details);
  const outputDetails =
    asRecord(usage.output_tokens_details) ?? asRecord(usage.completion_tokens_details);

  const normalized: RequestLogUsage = {
    inputTokens: firstDefinedNumber(usage.input_tokens, usage.prompt_tokens),
    cachedTokens: firstDefinedNumber(inputDetails?.cached_tokens),
    outputTokens: firstDefinedNumber(usage.output_tokens, usage.completion_tokens),
    reasoningTokens: firstDefinedNumber(outputDetails?.reasoning_tokens),
    totalTokens: firstDefinedNumber(usage.total_tokens),
  };

  return Object.values(normalized).some((entry) => entry !== undefined) ? normalized : undefined;
};

const appendText = (current: string, next: unknown) =>
  typeof next === 'string' ? current + next : current;

const readChoiceDelta = (payload: JsonRecord) => {
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  const firstChoice = asRecord(choices[0]);
  const delta = asRecord(firstChoice?.delta);
  return {
    content: readString(delta?.content),
    reasoning: readString(delta?.reasoning_content),
    finishReason: readString(firstChoice?.finish_reason),
  };
};

const extractCompletedOutput = (response: JsonRecord) => {
  let reasoning = '';
  let content = '';
  const output = Array.isArray(response.output) ? response.output : [];

  for (const rawItem of output) {
    const item = asRecord(rawItem);
    if (!item) continue;

    if (item.type === 'reasoning') {
      const summaries = Array.isArray(item.summary) ? item.summary : [];
      for (const rawSummary of summaries) {
        const summary = asRecord(rawSummary);
        reasoning = appendText(reasoning, summary?.text);
      }
    }

    if (item.type === 'message') {
      const parts = Array.isArray(item.content) ? item.content : [];
      for (const rawPart of parts) {
        const part = asRecord(rawPart);
        if (part?.type === 'output_text') content = appendText(content, part.text);
      }
    }
  }

  return { reasoning, content };
};

const summarizeTimelinePayload = (payload: JsonRecord): string | undefined => {
  const delta = readString(payload.delta);
  if (delta !== undefined) {
    return delta.length > 80 ? 'delta · ' + delta.slice(0, 77) + '…' : 'delta · ' + delta;
  }

  const choice = readChoiceDelta(payload);
  if (choice.content) {
    return choice.content.length > 80
      ? 'content · ' + choice.content.slice(0, 77) + '…'
      : 'content · ' + choice.content;
  }
  if (choice.reasoning) {
    return choice.reasoning.length > 80
      ? 'reasoning · ' + choice.reasoning.slice(0, 77) + '…'
      : 'reasoning · ' + choice.reasoning;
  }
  if (choice.finishReason) return 'finish · ' + choice.finishReason;

  const response = asRecord(payload.response);
  const status = readString(response?.status) ?? readString(payload.status);
  return status ? 'status · ' + status : undefined;
};

const parseStreamSummary = (body: string): RequestLogStreamSummary | undefined => {
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  const hasSse = lines.some(
    (line) => line.startsWith('data:') || line.startsWith('event:') || line.startsWith(': xai-usage ')
  );
  if (!hasSse) return undefined;

  const summary: RequestLogStreamSummary = {
    reasoning: '',
    content: '',
    timeline: [],
  };
  let currentEvent = '';

  const applyPayload = (payload: JsonRecord, eventName: string) => {
    const payloadType = readString(payload.type);
    const event = payloadType ?? eventName || 'data';
    const sequenceNumber = readNumber(payload.sequence_number);

    if (event === 'response.reasoning_summary_text.delta') {
      summary.reasoning = appendText(summary.reasoning, payload.delta);
    } else if (event === 'response.output_text.delta') {
      summary.content = appendText(summary.content, payload.delta);
    } else {
      const choice = readChoiceDelta(payload);
      if (choice.reasoning) summary.reasoning += choice.reasoning;
      if (choice.content) summary.content += choice.content;
      if (choice.finishReason) summary.finishReason = choice.finishReason;
    }

    const response = asRecord(payload.response);
    summary.model =
      readString(payload.model) ?? readString(response?.model) ?? summary.model;
    summary.serviceTier =
      readString(payload.service_tier) ?? readString(response?.service_tier) ?? summary.serviceTier;

    const directUsage = normalizeUsage(payload.usage);
    const responseUsage = normalizeUsage(response?.usage);
    if (directUsage || responseUsage) summary.usage = responseUsage ?? directUsage;

    if (event === 'response.completed' && response) {
      const completed = extractCompletedOutput(response);
      if (!summary.reasoning && completed.reasoning) summary.reasoning = completed.reasoning;
      if (!summary.content && completed.content) summary.content = completed.content;
    }

    summary.timeline.push({
      event,
      sequenceNumber,
      detail: summarizeTimelinePayload(payload),
    });
  };

  for (const line of lines) {
    if (!line) {
      currentEvent = '';
      continue;
    }

    if (line.startsWith('event:')) {
      currentEvent = line.slice('event:'.length).trim();
      continue;
    }

    if (line.startsWith(': xai-usage ')) {
      const parsed = tryParseJson(line.slice(': xai-usage '.length));
      const usage = normalizeUsage(parsed);
      if (usage) summary.usage = usage;
      summary.timeline.push({ event: 'xai-usage', detail: 'usage update' });
      continue;
    }

    if (!line.startsWith('data:')) continue;

    const data = line.slice('data:'.length).trim();
    if (data === '[DONE]') {
      summary.timeline.push({ event: 'done' });
      currentEvent = '';
      continue;
    }

    const parsed = asRecord(tryParseJson(data));
    if (parsed) applyPayload(parsed, currentEvent);
    currentEvent = '';
  }

  return summary;
};

const parseApiMessage = (value: string): RequestLogHttpMessage => {
  const metaLines: string[] = [];
  const headerLines: string[] = [];
  const bodyLines: string[] = [];
  let state: 'meta' | 'headers' | 'body' = 'meta';

  for (const line of value.split('\n')) {
    if (line.trim() === 'Headers:') {
      state = 'headers';
      continue;
    }
    if (line.trim() === 'Body:') {
      state = 'body';
      continue;
    }
    if (state === 'meta') metaLines.push(line);
    if (state === 'headers') headerLines.push(line);
    if (state === 'body') bodyLines.push(line);
  }

  const body = bodyLines.join('\n').trim();
  return {
    meta: parseKeyValueLines(metaLines.join('\n')),
    headers: parseHeaderLines(headerLines.join('\n')),
    body,
    prettyBody: prettyPrintRequestLogBody(body),
    stream: parseStreamSummary(body),
  };
};

const parseFinalResponse = (value: string): RequestLogHttpMessage => {
  const separator = value.indexOf('\n\n');
  const head = separator >= 0 ? value.slice(0, separator) : value;
  const body = separator >= 0 ? value.slice(separator + 2).trim() : '';
  const lines = head.split('\n');
  const statusLine = lines.shift() ?? '';

  return {
    meta: parseKeyValueLines(statusLine),
    headers: parseHeaderLines(lines.join('\n')),
    body,
    prettyBody: prettyPrintRequestLogBody(body),
    stream: parseStreamSummary(body),
  };
};

type RawSection = {
  name: string;
  content: string;
};

const splitSections = (raw: string): RawSection[] => {
  const normalized = raw.replace(/\r\n/g, '\n');
  const pattern = /^=== (.+?) ===\s*$/gm;
  const matches = Array.from(normalized.matchAll(pattern));
  const sections: RawSection[] = [];

  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const start = (match.index ?? 0) + match[0].length;
    const end = index + 1 < matches.length ? (matches[index + 1].index ?? normalized.length) : normalized.length;
    sections.push({
      name: match[1].trim(),
      content: normalized.slice(start, end).replace(/^\n+|\n+$/g, ''),
    });
  }

  return sections;
};

export const parseRequestLog = (raw: string): ParsedRequestLog => {
  const trace: ParsedRequestLog = {
    info: {},
    requestHeaders: [],
    requestBody: '',
    requestBodyPretty: '',
    attempts: [],
    raw,
  };

  const attempts = new Map<number, RequestLogAttempt>();

  for (const section of splitSections(raw)) {
    if (section.name === 'REQUEST INFO') {
      trace.info = parseKeyValueLines(section.content);
      continue;
    }

    if (section.name === 'HEADERS') {
      trace.requestHeaders = parseHeaderLines(section.content);
      continue;
    }

    if (section.name === 'REQUEST BODY') {
      trace.requestBody = section.content.trim();
      trace.requestBodyPretty = prettyPrintRequestLogBody(trace.requestBody);
      trace.requestBodyJson = tryParseJson(trace.requestBody);
      const requestBody = asRecord(trace.requestBodyJson);
      trace.requestedModel = readString(requestBody?.model);
      trace.streaming = typeof requestBody?.stream === 'boolean' ? requestBody.stream : undefined;
      continue;
    }

    const apiRequestMatch = /^API REQUEST (\d+)$/.exec(section.name);
    if (apiRequestMatch) {
      const attemptIndex = Number(apiRequestMatch[1]);
      const attempt = attempts.get(attemptIndex) ?? { index: attemptIndex };
      attempt.request = parseApiMessage(section.content);
      attempts.set(attemptIndex, attempt);
      continue;
    }

    const apiResponseMatch = /^API RESPONSE (\d+)$/.exec(section.name);
    if (apiResponseMatch) {
      const attemptIndex = Number(apiResponseMatch[1]);
      const attempt = attempts.get(attemptIndex) ?? { index: attemptIndex };
      attempt.response = parseApiMessage(section.content);
      attempts.set(attemptIndex, attempt);
      continue;
    }

    if (section.name === 'RESPONSE') {
      trace.response = parseFinalResponse(section.content);
    }
  }

  trace.attempts = Array.from(attempts.values()).sort((a, b) => a.index - b.index);
  return trace;
};
