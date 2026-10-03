import { describe, expect, it } from 'vitest';
import { parseRequestLog, prettyPrintRequestLogBody } from './requestLogParser';

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
    expect(trace.attempts).toHaveLength(1);
    expect(trace.attempts[0]?.request?.meta['Upstream URL']).toBe(
      'https://example.test/v1/responses'
    );
    expect(trace.attempts[0]?.response?.meta.Status).toBe('200');
    expect(trace.response?.meta.Status).toBe('200');
  });

  it('reconstructs Responses API SSE into readable reasoning and assistant text', () => {
    const stream = parseRequestLog(sample).attempts[0]?.response?.stream;

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
    expect(stream?.timeline.map((item) => item.event)).toContain(
      'response.output_text.delta'
    );
  });

  it('reconstructs OpenAI-compatible chat completion SSE', () => {
    const stream = parseRequestLog(sample).response?.stream;

    expect(stream?.reasoning).toBe('The user sent a greeting.');
    expect(stream?.content).toBe('Hey!');
    expect(stream?.finishReason).toBe('stop');
    expect(stream?.usage?.totalTokens).toBe(337);
    expect(stream?.timeline[stream.timeline.length - 1]?.event).toBe('done');
  });

  it('pretty prints JSON bodies without changing non-JSON text', () => {
    expect(prettyPrintRequestLogBody('{"a":1,"b":{"c":2}}')).toBe(
      ['{', '  "a": 1,', '  "b": {', '    "c": 2', '  }', '}'].join('\n')
    );
    expect(prettyPrintRequestLogBody('not-json')).toBe('not-json');
  });
});
