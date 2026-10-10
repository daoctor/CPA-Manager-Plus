import { describe, expect, it } from 'vitest';
import { humanizeRequestBody, humanizeResponseBody, parseRequestLog, parseRequestLogData } from './requestLogParser';

const sample = [
  '=== REQUEST INFO ===',
  'Version: v8.0.12',
  'URL: /v1/chat/completions',
  'Method: POST',
  'Timestamp: 2026-10-03T09:12:07.829594866+08:00',
  '',
  '=== HEADERS ===',
  'Content-Type: application/json',
  'X-Request-Id: request-1',
  '',
  '=== REQUEST BODY ===',
  '{"model":"grok-test","stream":true,"messages":[{"role":"user","content":"hi"}]}',
  '',
  '=== API REQUEST 1 ===',
  'Timestamp: 2026-10-03T09:12:07.831310427+08:00',
  'Upstream URL: https://example.test/v1/responses',
  'HTTP Method: POST',
  '',
  'Headers:',
  'Content-Type: application/json',
  '',
  'Body:',
  '{"model":"grok-test","stream":true}',
  '',
  '=== API RESPONSE 1 ===',
  'Timestamp: 2026-10-03T09:12:08.271897553+08:00',
  '',
  'Status: 200',
  'Headers:',
  'Content-Type: text/event-stream',
  '',
  'Body:',
  'event: response.reasoning_summary_text.delta',
  'data: {"sequence_number":4,"type":"response.reasoning_summary_text.delta","delta":"The user sent a greeting."}',
  '',
  'event: response.output_text.delta',
  'data: {"sequence_number":10,"type":"response.output_text.delta","delta":"Hey"}',
  '',
  'event: response.output_text.delta',
  'data: {"sequence_number":11,"type":"response.output_text.delta","delta":"!"}',
  '',
  'event: response.completed',
  'data: {"sequence_number":12,"type":"response.completed","response":{"model":"grok-test","service_tier":"default","status":"completed","usage":{"input_tokens":187,"input_tokens_details":{"cached_tokens":128},"output_tokens":150,"output_tokens_details":{"reasoning_tokens":140},"total_tokens":337},"output":[]}}',
  '',
  '=== RESPONSE ===',
  'Status: 200',
  'Content-Type: text/event-stream',
  '',
  'data: {"model":"grok-test","choices":[{"index":0,"delta":{"role":"assistant","reasoning_content":"The user sent a greeting."},"finish_reason":null}]}',
  '',
  'data: {"model":"grok-test","choices":[{"index":0,"delta":{"content":"Hey"},"finish_reason":null}]}',
  '',
  'data: {"model":"grok-test","choices":[{"index":0,"delta":{"content":"!"},"finish_reason":null}]}',
  '',
  'data: {"model":"grok-test","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":187,"completion_tokens":150,"total_tokens":337,"prompt_tokens_details":{"cached_tokens":128},"completion_tokens_details":{"reasoning_tokens":140}}}',
  '',
  'data: [DONE]',
].join('\n');

const claudeSse = [
  'event: message_start',
  'data: {"type":"message_start","message":{"type":"message","model":"claude-test","content":[],"usage":{"input_tokens":2,"cache_read_input_tokens":4096,"cache_creation_input_tokens":128,"output_tokens":1}}}',
  '',
  'event: content_block_start',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Let me check."}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"not-for-display"}}',
  '',
  'event: content_block_stop',
  'data: {"type":"content_block_stop","index":0}',
  '',
  'event: content_block_start',
  'data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Hello "}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"world"}}',
  '',
  'event: content_block_stop',
  'data: {"type":"content_block_stop","index":1}',
  '',
  'event: message_delta',
  'data: {"type":"message_delta","delta":{"stop_reason":null},"usage":{"output_tokens":3}}',
  '',
  'event: message_delta',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":6}}',
  '',
  'event: message_stop',
  'data: {"type":"message_stop"}',
  '',
].join('\n');

const claudeLog = [
  '=== REQUEST INFO ===',
  'URL: /v1/messages',
  'Method: POST',
  '',
  '=== REQUEST BODY ===',
  '{"model":"claude-test","stream":true,"messages":[{"role":"user","content":"hello"}]}',
  '',
  '=== API RESPONSE 1 ===',
  'Timestamp: 2026-10-10T09:50:58+08:00',
  'Status: 200',
  'Headers:',
  'Content-Type: text/event-stream; charset=utf-8',
  'Content-Encoding: gzip',
  '',
  'Body:',
  claudeSse,
  '=== RESPONSE ===',
  'Status: 200',
  'Content-Type: text/event-stream',
  '',
  claudeSse,
].join('\n');

describe('requestLogParser', () => {
  it('parses request metadata, body, attempts, and final response', () => {
    const trace = parseRequestLog(sample);

    expect(trace.info).toMatchObject({
      Version: 'v8.0.12',
      URL: '/v1/chat/completions',
      Method: 'POST',
    });
    expect(trace.requestedModel).toBe('grok-test');
    expect(trace.streaming).toBe(true);
    expect(trace.clientRequest.messages).toEqual([{ role: 'user', content: 'hi' }]);
    expect(trace.attempts).toHaveLength(1);
    expect(trace.attempts[0]?.request?.meta['Upstream URL']).toBe(
      'https://example.test/v1/responses'
    );
    expect(trace.attempts[0]?.response?.meta.Status).toBe('200');
    expect(trace.response?.meta.Status).toBe('200');
  });

  it('reconstructs Responses API SSE into readable reasoning and assistant text', () => {
    const stream = parseRequestLog(sample).attempts[0]?.response?.response;

    expect(stream?.reasoning).toBe('The user sent a greeting.');
    expect(stream?.content).toBe('Hey!');
    expect(stream?.model).toBe('grok-test');
    expect(stream?.serviceTier).toBe('default');
    expect(stream?.usage).toEqual({
      inputTokens: 187,
      cachedTokens: 128,
      outputTokens: 150,
      reasoningTokens: 140,
      totalTokens: 337,
    });
  });

  it('reconstructs OpenAI-compatible chat completion SSE', () => {
    const stream = parseRequestLog(sample).response?.response;

    expect(stream?.reasoning).toBe('The user sent a greeting.');
    expect(stream?.content).toBe('Hey!');
    expect(stream?.finishReason).toBe('stop');
    expect(stream?.usage?.totalTokens).toBe(337);
  });

  it('humanizes request and response JSON', () => {
    expect(
      humanizeRequestBody(
        '{"model":"gpt-test","messages":[{"role":"system","content":"Be concise"},{"role":"user","content":"Hello"}]}'
      ).messages
    ).toEqual([
      { role: 'system', content: 'Be concise' },
      { role: 'user', content: 'Hello' },
    ]);

    expect(
      humanizeResponseBody(
        '{"model":"gpt-test","choices":[{"message":{"role":"assistant","content":"Hi there"},"finish_reason":"stop"}]}'
      )
    ).toMatchObject({
      model: 'gpt-test',
      content: 'Hi there',
      finishReason: 'stop',
    });
  });

  it('reconstructs native Claude SSE text, thinking, and cumulative usage', () => {
    const trace = parseRequestLog(claudeLog);
    const upstream = trace.attempts[0]?.response?.response;
    const downstream = trace.response?.response;

    for (const response of [upstream, downstream]) {
      expect(response?.model).toBe('claude-test');
      expect(response?.reasoning).toBe('Let me check.');
      expect(response?.content).toBe('Hello world');
      expect(response?.finishReason).toBe('end_turn');
      expect(response?.usage).toEqual({
        inputTokens: 2,
        cachedTokens: 4096,
        cacheCreationTokens: 128,
        outputTokens: 6,
        reasoningTokens: undefined,
        totalTokens: 4232,
      });
    }
  });

  it('does not treat an incomplete Claude stream as having a final total', () => {
    const incompleteSse = claudeSse.split('event: message_stop')[0];
    const trace = parseRequestLog([
      '=== API RESPONSE 1 ===',
      'Status: 200',
      'Headers:',
      'Content-Type: text/event-stream',
      '',
      'Body:',
      incompleteSse,
    ].join('\n'));

    expect(trace.attempts[0]?.response?.response?.usage?.outputTokens).toBe(6);
    expect(trace.attempts[0]?.response?.response?.usage?.totalTokens).toBeUndefined();
  });

  it('shows Claude tool calls even without a text content block', () => {
    const sse = [
      'event: message_start',
      'data: {"type":"message_start","message":{"model":"claude-test","usage":{"input_tokens":0,"output_tokens":1}}}',
      '',
      'event: content_block_start',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","name":"lookup","input":{}}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"key\":"}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\"test\"}"}}',
      '',
      'event: content_block_stop',
      'data: {"type":"content_block_stop","index":0}',
      '',
      'event: message_delta',
      'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":6}}',
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
    ].join('\n');
    const trace = parseRequestLog([
      '=== API RESPONSE 1 ===',
      'Status: 200',
      'Headers:',
      'Content-Type: text/event-stream',
      '',
      'Body:',
      sse,
    ].join('\n'));

    expect(trace.attempts[0]?.response?.response?.content).toContain('[Tool: lookup]');
    expect(trace.attempts[0]?.response?.response?.content).toContain('"key": "test"');
    expect(trace.attempts[0]?.response?.response?.finishReason).toBe('tool_use');
    expect(trace.attempts[0]?.response?.response?.usage?.totalTokens).toBe(6);
  });

  it('humanizes non-streaming Claude cache creation details without double counting', () => {
    const response = humanizeResponseBody(JSON.stringify({
      type: 'message',
      model: 'claude-test',
      content: [{ type: 'text', text: 'Hi' }],
      usage: {
        input_tokens: 2,
        cache_read_input_tokens: 100,
        cache_creation: {
          ephemeral_5m_input_tokens: 10,
          ephemeral_1h_input_tokens: 20,
        },
        output_tokens: 6,
      },
    }));

    expect(response.content).toBe('Hi');
    expect(response.usage).toMatchObject({
      inputTokens: 2,
      cachedTokens: 100,
      cacheCreationTokens: 30,
      outputTokens: 6,
      totalTokens: 138,
    });
  });

  it('parses Blob data without a size cutoff', async () => {
    if (typeof Blob === 'undefined' || typeof Blob.prototype.stream !== 'function') return;

    const trace = await parseRequestLogData(new Blob([sample]));
    expect(trace.response?.response?.content).toBe('Hey!');
    expect(trace.clientRequest.messages[0]?.content).toBe('hi');
  });
});
