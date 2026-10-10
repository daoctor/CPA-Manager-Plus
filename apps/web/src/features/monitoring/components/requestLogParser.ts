type JsonRecord = Record<string, unknown>;

export type RequestLogHeader = {
  name: string;
  value: string;
};

export type RequestLogUsage = {
  inputTokens?: number;
  cachedTokens?: number;
  cacheCreationTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
};

export type RequestLogReadableMessage = {
  role: string;
  content: string;
};

export type RequestLogReadableRequest = {
  model?: string;
  streaming?: boolean;
  instructions?: string;
  messages: RequestLogReadableMessage[];
  parameters: Record<string, string>;
};

export type RequestLogReadableResponse = {
  model?: string;
  serviceTier?: string;
  reasoning: string;
  content: string;
  finishReason?: string;
  usage?: RequestLogUsage;
};

export type RequestLogHttpMessage = {
  meta: Record<string, string>;
  headers: RequestLogHeader[];
  request?: RequestLogReadableRequest;
  response?: RequestLogReadableResponse;
};

export type RequestLogAttempt = {
  index: number;
  request?: RequestLogHttpMessage;
  response?: RequestLogHttpMessage;
};

export type ParsedRequestLog = {
  info: Record<string, string>;
  requestHeaders: RequestLogHeader[];
  clientRequest: RequestLogReadableRequest;
  requestedModel?: string;
  streaming?: boolean;
  attempts: RequestLogAttempt[];
  response?: RequestLogHttpMessage;
};

const emptyRequest = (): RequestLogReadableRequest => ({
  messages: [],
  parameters: {},
});

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

const setKeyValue = (target: Record<string, string>, line: string) => {
  const separator = line.indexOf(':');
  if (separator <= 0) return;
  const key = line.slice(0, separator).trim();
  const value = line.slice(separator + 1).trim();
  if (key) target[key] = value;
};

const pushHeader = (target: RequestLogHeader[], line: string) => {
  const separator = line.indexOf(':');
  if (separator <= 0) return;
  const name = line.slice(0, separator).trim();
  const value = line.slice(separator + 1).trim();
  if (name) target.push({ name, value });
};

const normalizeUsage = (value: unknown): RequestLogUsage | undefined => {
  const usage = asRecord(value);
  if (!usage) return undefined;

  const inputDetails = asRecord(usage.input_tokens_details) ?? asRecord(usage.prompt_tokens_details);
  const outputDetails =
    asRecord(usage.output_tokens_details) ?? asRecord(usage.completion_tokens_details);
  const cacheCreation = asRecord(usage.cache_creation);
  const cacheCreation5m = readNumber(cacheCreation?.ephemeral_5m_input_tokens);
  const cacheCreation1h = readNumber(cacheCreation?.ephemeral_1h_input_tokens);
  const cacheCreationTokens = firstDefinedNumber(
    usage.cache_creation_input_tokens,
    cacheCreation5m === undefined && cacheCreation1h === undefined
      ? undefined
      : (cacheCreation5m ?? 0) + (cacheCreation1h ?? 0)
  );

  const normalized: RequestLogUsage = {
    inputTokens: firstDefinedNumber(usage.input_tokens, usage.prompt_tokens),
    cachedTokens: firstDefinedNumber(usage.cache_read_input_tokens, inputDetails?.cached_tokens),
    ...(cacheCreationTokens !== undefined ? { cacheCreationTokens } : {}),
    outputTokens: firstDefinedNumber(usage.output_tokens, usage.completion_tokens),
    reasoningTokens: firstDefinedNumber(outputDetails?.reasoning_tokens),
    totalTokens: firstDefinedNumber(usage.total_tokens),
  };

  return Object.values(normalized).some((entry) => entry !== undefined) ? normalized : undefined;
};

// SSE usage events carry cumulative counters and often omit fields found on earlier events.
const mergeUsage = (
  current: RequestLogUsage | undefined,
  next: RequestLogUsage | undefined
): RequestLogUsage | undefined => {
  if (!next) return current;
  const merged = { ...current };
  for (const field of Object.keys(next) as (keyof RequestLogUsage)[]) {
    const value = next[field];
    if (value !== undefined) merged[field] = value;
  }
  return merged;
};

// Claude's input_tokens excludes cache read/write tokens, unlike OpenAI's input_tokens.
// Never add the cached subset to an OpenAI total.
const withAnthropicTotal = (usage: RequestLogUsage | undefined): RequestLogUsage | undefined => {
  if (
    !usage ||
    usage.totalTokens !== undefined ||
    usage.inputTokens === undefined ||
    usage.outputTokens === undefined
  ) {
    return usage;
  }
  return {
    ...usage,
    totalTokens:
      usage.inputTokens +
      (usage.cachedTokens ?? 0) +
      (usage.cacheCreationTokens ?? 0) +
      usage.outputTokens,
  };
};

const extractText = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (!value) return '';

  if (Array.isArray(value)) {
    return value
      .map((entry) => extractText(entry))
      .filter(Boolean)
      .join('\n');
  }

  const record = asRecord(value);
  if (!record) return '';

  for (const key of ['text', 'input_text', 'output_text']) {
    const text = readString(record[key]);
    if (text) return text;
  }

  if (record.content !== undefined) return extractText(record.content);
  if (record.parts !== undefined) return extractText(record.parts);

  const type = readString(record.type);
  if (type && ['image', 'image_url', 'input_image'].includes(type)) return '[image]';

  return '';
};

const pushMessage = (
  messages: RequestLogReadableMessage[],
  role: unknown,
  content: unknown,
  fallbackRole = 'message'
) => {
  const text = extractText(content).trim();
  if (!text) return;
  messages.push({
    role: readString(role) ?? fallbackRole,
    content: text,
  });
};

const scalarValue = (value: unknown): string | undefined => {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return undefined;
};

const REQUEST_CONTENT_KEYS = new Set([
  'messages',
  'input',
  'prompt',
  'contents',
  'instructions',
  'tools',
  'metadata',
  'model',
  'stream',
]);

export const humanizeRequestBody = (body: string): RequestLogReadableRequest => {
  const trimmed = body.trim();
  if (!trimmed) return emptyRequest();

  const parsed = tryParseJson(trimmed);
  const root = asRecord(parsed);
  if (!root) {
    return {
      messages: [{ role: 'body', content: trimmed }],
      parameters: {},
    };
  }

  const messages: RequestLogReadableMessage[] = [];

  if (Array.isArray(root.messages)) {
    for (const item of root.messages) {
      const message = asRecord(item);
      if (message) pushMessage(messages, message.role, message.content);
    }
  }

  if (Array.isArray(root.input)) {
    for (const item of root.input) {
      const message = asRecord(item);
      if (message) {
        pushMessage(
          messages,
          message.role,
          message.content ?? message.input,
          readString(message.type) ?? 'input'
        );
      }
    }
  } else if (typeof root.input === 'string') {
    pushMessage(messages, 'input', root.input);
  }

  if (Array.isArray(root.contents)) {
    for (const item of root.contents) {
      const message = asRecord(item);
      if (message) pushMessage(messages, message.role, message.parts ?? message.content, 'user');
    }
  }

  if (messages.length === 0 && root.prompt !== undefined) {
    pushMessage(messages, 'prompt', root.prompt);
  }

  const parameters: Record<string, string> = {};
  for (const [key, value] of Object.entries(root)) {
    if (REQUEST_CONTENT_KEYS.has(key)) continue;
    const scalar = scalarValue(value);
    if (scalar !== undefined) parameters[key] = scalar;
  }

  return {
    model: readString(root.model),
    streaming: typeof root.stream === 'boolean' ? root.stream : undefined,
    instructions: readString(root.instructions),
    messages,
    parameters,
  };
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

const extractResponsesOutput = (response: JsonRecord) => {
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

const extractAnthropicContent = (root: JsonRecord) => {
  let reasoning = '';
  let content = '';
  const blocks = Array.isArray(root.content) ? root.content : [];

  for (const rawBlock of blocks) {
    const block = asRecord(rawBlock);
    if (!block) continue;
    const text = readString(block.text);
    if (block.type === 'thinking' && text) reasoning += text;
    if (block.type === 'text' && text) content += text;
    if (block.type === 'tool_use') {
      const name = readString(block.name) ?? 'unknown';
      const input = JSON.stringify(block.input ?? {}, null, 2);
      content += (content ? '\n\n' : '') + '[Tool: ' + name + ']\n' + input;
    }
  }

  return { reasoning, content };
};

const extractGeminiContent = (root: JsonRecord): string => {
  const candidates = Array.isArray(root.candidates) ? root.candidates : [];
  const first = asRecord(candidates[0]);
  const content = asRecord(first?.content);
  return extractText(content?.parts);
};

export const humanizeResponseBody = (body: string): RequestLogReadableResponse => {
  const trimmed = body.trim();
  const parsed = tryParseJson(trimmed);
  const root = asRecord(parsed);

  if (!root) {
    return {
      reasoning: '',
      content: trimmed,
    };
  }

  let reasoning = '';
  let content = '';
  const responses = extractResponsesOutput(root);
  reasoning += responses.reasoning;
  content += responses.content;

  const choices = Array.isArray(root.choices) ? root.choices : [];
  const firstChoice = asRecord(choices[0]);
  const message = asRecord(firstChoice?.message);
  if (message) {
    reasoning = appendText(reasoning, message.reasoning_content);
    content = appendText(content, message.content);
  }
  const finishReason = readString(firstChoice?.finish_reason);

  const anthropic = extractAnthropicContent(root);
  reasoning += anthropic.reasoning;
  content += anthropic.content;

  if (!content) content = extractGeminiContent(root);
  if (!content) content = readString(root.output_text) ?? readString(root.text) ?? '';

  const error = asRecord(root.error);
  if (!content && error) content = readString(error.message) ?? '';

  return {
    model: readString(root.model),
    serviceTier: readString(root.service_tier),
    reasoning,
    content,
    finishReason,
    usage: root.type === 'message'
      ? withAnthropicTotal(normalizeUsage(root.usage))
      : normalizeUsage(root.usage),
  };
};

class StreamSummaryBuilder {
  private currentEvent = '';
  private isAnthropic = false;
  private anthroCompleted = false;
  private toolCalls = new Map<number, { name: string; input: unknown; partialJson: string }>();

  readonly summary: RequestLogReadableResponse = {
    reasoning: '',
    content: '',
  };

  private flushToolCall(index: number) {
    const tool = this.toolCalls.get(index);
    if (!tool) return;
    const args = tool.partialJson
      ? (tryParseJson(tool.partialJson) ?? tool.partialJson)
      : tool.input;
    const readableArgs = typeof args === 'string' ? args : JSON.stringify(args ?? {}, null, 2);
    this.summary.content +=
      (this.summary.content ? '\n\n' : '') + '[Tool: ' + tool.name + ']\n' + readableArgs;
    this.toolCalls.delete(index);
  }

  consume(line: string) {
    if (!line) {
      this.currentEvent = '';
      return;
    }

    if (line.startsWith('event:')) {
      this.currentEvent = line.slice('event:'.length).trim();
      return;
    }

    if (line.startsWith(': xai-usage ')) {
      this.summary.usage = mergeUsage(
        this.summary.usage,
        normalizeUsage(tryParseJson(line.slice(': xai-usage '.length)))
      );
      return;
    }

    if (!line.startsWith('data:')) return;

    const data = line.slice('data:'.length).trim();
    if (data === '[DONE]') {
      this.currentEvent = '';
      return;
    }

    const payload = asRecord(tryParseJson(data));
    if (!payload) {
      this.currentEvent = '';
      return;
    }

    const event = readString(payload.type) ?? this.currentEvent;
    const message = asRecord(payload.message);
    const delta = asRecord(payload.delta);
    const response = asRecord(payload.response);

    if (
      event === 'message_start' ||
      event === 'content_block_start' ||
      event === 'content_block_delta' ||
      event === 'content_block_stop' ||
      event === 'message_delta' ||
      event === 'message_stop'
    ) {
      this.isAnthropic = true;
    }

    if (event === 'message_start') {
      this.summary.finishReason = readString(message?.stop_reason) ?? this.summary.finishReason;
    } else if (event === 'content_block_start') {
      const block = asRecord(payload.content_block);
      if (block?.type === 'text') {
        this.summary.content = appendText(this.summary.content, block.text);
      } else if (block?.type === 'thinking') {
        this.summary.reasoning = appendText(this.summary.reasoning, block.thinking);
      } else if (block?.type === 'tool_use' || block?.type === 'server_tool_use') {
        const index = readNumber(payload.index);
        if (index !== undefined) {
          this.toolCalls.set(index, {
            name: readString(block.name) ?? 'unknown',
            input: block.input ?? {},
            partialJson: '',
          });
        }
      }
    } else if (event === 'content_block_delta') {
      if (delta?.type === 'text_delta') {
        this.summary.content = appendText(this.summary.content, delta.text);
      } else if (delta?.type === 'thinking_delta') {
        this.summary.reasoning = appendText(this.summary.reasoning, delta.thinking);
      } else if (delta?.type === 'input_json_delta') {
        const index = readNumber(payload.index);
        const tool = index === undefined ? undefined : this.toolCalls.get(index);
        if (tool) tool.partialJson = appendText(tool.partialJson, delta.partial_json);
      }
    } else if (event === 'content_block_stop') {
      const index = readNumber(payload.index);
      if (index !== undefined) this.flushToolCall(index);
    } else if (event === 'message_delta') {
      this.summary.finishReason = readString(delta?.stop_reason) ?? this.summary.finishReason;
    } else if (event === 'message_stop') {
      this.anthroCompleted = true;
    } else if (event === 'response.reasoning_summary_text.delta') {
      this.summary.reasoning = appendText(this.summary.reasoning, payload.delta);
    } else if (event === 'response.output_text.delta') {
      this.summary.content = appendText(this.summary.content, payload.delta);
    } else {
      const choice = readChoiceDelta(payload);
      if (choice.reasoning) this.summary.reasoning += choice.reasoning;
      if (choice.content) this.summary.content += choice.content;
      if (choice.finishReason) this.summary.finishReason = choice.finishReason;
    }

    this.summary.model =
      readString(message?.model) ??
      readString(payload.model) ??
      readString(response?.model) ??
      this.summary.model;
    this.summary.serviceTier =
      readString(payload.service_tier) ??
      readString(response?.service_tier) ??
      this.summary.serviceTier;

    this.summary.usage = mergeUsage(
      mergeUsage(this.summary.usage, normalizeUsage(message?.usage)),
      normalizeUsage(response?.usage) ?? normalizeUsage(payload.usage)
    );

    if (event === 'response.completed' && response) {
      const completed = extractResponsesOutput(response);
      if (!this.summary.reasoning && completed.reasoning) this.summary.reasoning = completed.reasoning;
      if (!this.summary.content && completed.content) this.summary.content = completed.content;
    }

    this.currentEvent = '';
  }

  finish(): RequestLogReadableResponse {
    for (const index of Array.from(this.toolCalls.keys())) this.flushToolCall(index);
    if (this.isAnthropic && this.anthroCompleted) {
      this.summary.usage = withAnthropicTotal(this.summary.usage);
    }
    return this.summary;
  }
}

type MessageBuilderMode = 'request' | 'response' | 'final-response';

class MessageBuilder {
  readonly meta: Record<string, string> = {};
  readonly headers: RequestLogHeader[] = [];
  private state: 'meta' | 'headers' | 'body' = 'meta';
  private bodyLines: string[] = [];
  private stream?: StreamSummaryBuilder;

  constructor(private readonly mode: MessageBuilderMode) {}

  consume(line: string) {
    if (this.mode === 'final-response' && this.state === 'meta') {
      if (!line) {
        this.state = 'body';
        return;
      }

      if (line.startsWith('Status:')) {
        setKeyValue(this.meta, line);
      } else {
        pushHeader(this.headers, line);
      }
      return;
    }

    if (line === 'Headers:') {
      this.state = 'headers';
      return;
    }

    if (line === 'Body:') {
      this.state = 'body';
      return;
    }

    if (this.state === 'meta') {
      if (line) setKeyValue(this.meta, line);
      return;
    }

    if (this.state === 'headers') {
      if (line) pushHeader(this.headers, line);
      return;
    }

    if (this.mode !== 'request' && this.looksLikeStreamLine(line)) {
      if (!this.stream) {
        this.stream = new StreamSummaryBuilder();
        for (const buffered of this.bodyLines) this.stream.consume(buffered);
        this.bodyLines = [];
      }
      this.stream.consume(line);
      return;
    }

    if (this.stream) {
      this.stream.consume(line);
      return;
    }

    this.bodyLines.push(line);
  }

  finish(): RequestLogHttpMessage {
    const body = this.bodyLines.join('\n').trim();

    if (this.mode === 'request') {
      return {
        meta: this.meta,
        headers: this.headers,
        request: humanizeRequestBody(body),
      };
    }

    return {
      meta: this.meta,
      headers: this.headers,
      response: this.stream?.finish() ?? humanizeResponseBody(body),
    };
  }

  private looksLikeStreamLine(line: string) {
    if (
      line.startsWith('event:') ||
      line.startsWith('data:') ||
      line.startsWith(': xai-usage ')
    ) {
      return true;
    }

    return this.headers.some(
      (header) =>
        header.name.toLowerCase() === 'content-type' &&
        header.value.toLowerCase().includes('text/event-stream')
    );
  }
}

class IncrementalRequestLogParser {
  private buffer = '';
  private currentSection = '';
  private sectionLines: string[] = [];
  private messageBuilder?: MessageBuilder;
  private currentAttempt?: number;

  private readonly trace: ParsedRequestLog = {
    info: {},
    requestHeaders: [],
    clientRequest: emptyRequest(),
    attempts: [],
  };

  private readonly attempts = new Map<number, RequestLogAttempt>();

  push(chunk: string) {
    this.buffer += chunk;

    while (true) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) break;
      const rawLine = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      this.consumeLine(rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine);
    }
  }

  finish(): ParsedRequestLog {
    if (this.buffer) {
      const line = this.buffer.endsWith('\r') ? this.buffer.slice(0, -1) : this.buffer;
      this.consumeLine(line);
      this.buffer = '';
    }

    this.finishSection();
    this.trace.attempts = Array.from(this.attempts.values()).sort((a, b) => a.index - b.index);
    this.trace.requestedModel = this.trace.clientRequest.model;
    this.trace.streaming = this.trace.clientRequest.streaming;
    return this.trace;
  }

  private consumeLine(line: string) {
    const sectionMatch = /^=== (.+?) ===\s*$/.exec(line);
    if (sectionMatch) {
      this.finishSection();
      this.startSection(sectionMatch[1].trim());
      return;
    }

    if (!this.currentSection) return;

    if (this.messageBuilder) {
      this.messageBuilder.consume(line);
      return;
    }

    if (this.currentSection === 'REQUEST INFO') {
      if (line) setKeyValue(this.trace.info, line);
      return;
    }

    if (this.currentSection === 'HEADERS') {
      if (line) pushHeader(this.trace.requestHeaders, line);
      return;
    }

    this.sectionLines.push(line);
  }

  private startSection(name: string) {
    this.currentSection = name;
    this.sectionLines = [];
    this.currentAttempt = undefined;
    this.messageBuilder = undefined;

    const requestMatch = /^API REQUEST (\d+)$/.exec(name);
    if (requestMatch) {
      this.currentAttempt = Number(requestMatch[1]);
      this.messageBuilder = new MessageBuilder('request');
      return;
    }

    const responseMatch = /^API RESPONSE (\d+)$/.exec(name);
    if (responseMatch) {
      this.currentAttempt = Number(responseMatch[1]);
      this.messageBuilder = new MessageBuilder('response');
      return;
    }

    if (name === 'RESPONSE') {
      this.messageBuilder = new MessageBuilder('final-response');
    }
  }

  private finishSection() {
    if (!this.currentSection) return;

    if (this.currentSection === 'REQUEST BODY') {
      this.trace.clientRequest = humanizeRequestBody(this.sectionLines.join('\n'));
    }

    if (this.messageBuilder) {
      const message = this.messageBuilder.finish();

      if (this.currentSection === 'RESPONSE') {
        this.trace.response = message;
      } else if (this.currentAttempt !== undefined) {
        const attempt =
          this.attempts.get(this.currentAttempt) ?? { index: this.currentAttempt };
        if (this.currentSection.startsWith('API REQUEST ')) attempt.request = message;
        if (this.currentSection.startsWith('API RESPONSE ')) attempt.response = message;
        this.attempts.set(this.currentAttempt, attempt);
      }
    }

    this.currentSection = '';
    this.sectionLines = [];
    this.currentAttempt = undefined;
    this.messageBuilder = undefined;
  }
}

export const parseRequestLog = (raw: string): ParsedRequestLog => {
  const parser = new IncrementalRequestLogParser();
  parser.push(raw);
  return parser.finish();
};

export const parseRequestLogData = async (data: unknown): Promise<ParsedRequestLog> => {
  const parser = new IncrementalRequestLogParser();

  if (data instanceof Blob) {
    const reader = data.stream().getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      parser.push(decoder.decode(value, { stream: true }));
    }

    parser.push(decoder.decode());
    return parser.finish();
  }

  if (data instanceof ArrayBuffer) {
    parser.push(new TextDecoder().decode(data));
    return parser.finish();
  }

  if (typeof data === 'string') {
    parser.push(data);
    return parser.finish();
  }

  if (data !== null && data !== undefined) {
    try {
      parser.push(JSON.stringify(data));
    } catch {
      parser.push(String(data));
    }
  }

  return parser.finish();
};
