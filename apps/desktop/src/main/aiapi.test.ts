import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import Anthropic from '@anthropic-ai/sdk';
import {
  AI_TOOL_NAMES,
  API_MAX_TOKENS,
  MODEL_PRICES,
  RESEARCH_PROMPT,
  costOf,
  type AiToolResult,
  type ApiEffort,
  type ApiModel,
} from '@rulz/ai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  API_FIRST_MESSAGE,
  API_MAX_RESPONSES,
  API_RUN_MS,
  API_TEXT_MAX,
  firstRequestReserve,
  guardedFetch,
  makeApiClient,
  runApi,
  type AiApiClient,
  type AiApiEnd,
  type AiApiProgress,
  type AiApiRunOptions,
} from './aiapi';

const CANARY = 'sk-ant-test-canary-0000';
const MODEL: ApiModel = 'claude-sonnet-5-5';

interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

/** A response of the Messages API, as the loop reads one. */
function reply(
  stop: string,
  content: unknown[],
  usage: Usage = { input_tokens: 100, output_tokens: 50 },
  model: string = MODEL,
): unknown {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage,
  };
}

const text = (value: string): unknown => ({ type: 'text', text: value });
const use = (id: string, name: string, input: unknown = {}): unknown => ({
  type: 'tool_use',
  id,
  name,
  input,
});

type Step = unknown | Error | ((params: Record<string, unknown>, signal: AbortSignal) => unknown);

/** A client that answers from a list, and keeps what it was asked. */
function fakeClient(steps: Step[]): { client: AiApiClient; asked: Record<string, unknown>[] } {
  const asked: Record<string, unknown>[] = [];
  const client: AiApiClient = {
    messages: {
      async create(params, options) {
        asked.push(JSON.parse(JSON.stringify(params)) as Record<string, unknown>);
        const step = steps[asked.length - 1];
        if (step === undefined) throw new Error('The run asked for more than the test gave.');
        if (typeof step === 'function') {
          return await (step as (p: unknown, s: AbortSignal) => unknown)(params, options.signal);
        }
        if (step instanceof Error) throw step;
        return step;
      },
    },
  };
  return { client, asked };
}

function ok(value: unknown = { fine: true }): AiToolResult {
  return { ok: true, value };
}

interface Rig {
  options: AiApiRunOptions;
  progress: AiApiProgress[];
  busy: boolean[];
  calls: { name: string; input: unknown }[];
  stop: () => void;
}

function rig(
  client: AiApiClient,
  more: Partial<AiApiRunOptions> & {
    call?: (name: string, input: unknown) => Promise<AiToolResult>;
  } = {},
): Rig {
  const controller = new AbortController();
  const progress: AiApiProgress[] = [];
  const busy: boolean[] = [];
  const calls: { name: string; input: unknown }[] = [];
  const options: AiApiRunOptions = {
    client,
    call: async (name, input) => {
      calls.push({ name, input });
      return ok();
    },
    signal: controller.signal,
    isCurrent: () => true,
    model: MODEL,
    effort: 'medium' as ApiEffort,
    capUsd: 5,
    now: () => 0,
    onProgress: (p) => progress.push(p),
    onRequest: (b) => busy.push(b),
    ...more,
  };
  return { options, progress, busy, calls, stop: () => controller.abort() };
}

function end(result: AiApiProgress): AiApiEnd | null {
  return result.ended;
}

function statusError(status: number, message = 'oops'): Error {
  return new Anthropic.APIError(status, { error: { message } }, message, new Headers());
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the loop', () => {
  it('runs a tool and sends its answer back', async () => {
    const { client, asked } = fakeClient([
      reply('tool_use', [text('Looking.'), use('t1', 'get_session', {})]),
      reply('end_turn', [text('Done.')]),
    ]);
    const r = rig(client);
    const result = await runApi(r.options);
    expect(end(result)).toBe('done');
    expect(result.responses).toBe(2);
    expect(r.calls).toEqual([{ name: 'get_session', input: {} }]);
    expect(result.lastTool).toBe('get_session');
    expect(result.text).toBe('Looking.\n\nDone.');
    const second = asked[1]?.messages as { role: string; content: unknown }[];
    expect(second.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(second[2]?.content).toEqual([
      { type: 'tool_result', tool_use_id: 't1', content: JSON.stringify(ok()) },
    ]);
    expect(r.busy).toEqual([true, false, true, false]);
  });

  it('runs several tools of one turn one after another and answers them in one message', async () => {
    const { client, asked } = fakeClient([
      reply('tool_use', [
        use('a', 'get_session'),
        use('b', 'list_sources'),
        use('c', 'search_tree', { query: 'Smith' }),
      ]),
      reply('end_turn', [text('ok')]),
    ]);
    const order: string[] = [];
    const r = rig(client, {
      call: async (name) => {
        order.push(`start ${name}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push(`end ${name}`);
        return name === 'list_sources'
          ? { ok: false, reason: 'budget', message: 'No question is left.' }
          : ok();
      },
    });
    const result = await runApi(r.options);
    expect(end(result)).toBe('done');
    expect(order).toEqual([
      'start get_session',
      'end get_session',
      'start list_sources',
      'end list_sources',
      'start search_tree',
      'end search_tree',
    ]);
    const last = (asked[1]?.messages as { content: Record<string, unknown>[] }[]).at(-1);
    expect(last?.content.map((block) => block.tool_use_id)).toEqual(['a', 'b', 'c']);
    expect(last?.content.map((block) => block.is_error)).toEqual([undefined, true, undefined]);
  });

  it('ends on end_turn and keeps only text blocks, never thinking', async () => {
    const { client } = fakeClient([
      reply('end_turn', [
        { type: 'thinking', thinking: 'secret thoughts', signature: 'sig' },
        { type: 'redacted_thinking', data: 'abc' },
        text('The answer.'),
      ]),
    ]);
    const r = rig(client);
    const result = await runApi(r.options);
    expect(end(result)).toBe('done');
    expect(result.text).toBe('The answer.');
    expect(JSON.stringify(r.progress)).not.toContain('secret thoughts');
  });

  it('caps the text it keeps', async () => {
    const { client } = fakeClient([
      reply('end_turn', [text('a'.repeat(15_000)), text('b'.repeat(15_000))]),
    ]);
    const result = await runApi(rig(client).options);
    expect(result.text.length).toBe(API_TEXT_MAX);
    expect(result.text.startsWith('aaa')).toBe(true);
    expect(result.text.endsWith('b')).toBe(true);
  });

  it.each([
    ['refusal', 'declined'],
    ['max_tokens', 'max-tokens'],
    ['pause_turn', 'paused'],
    ['stop_sequence', 'unexpected'],
    ['model_context_window_exceeded', 'unexpected'],
    ['something_new', 'unexpected'],
  ] as const)('ends on the stop reason %s as %s, and asks nothing more', async (stop, why) => {
    const { client, asked } = fakeClient([reply(stop, [text('x')])]);
    const result = await runApi(rig(client).options);
    expect(end(result)).toBe(why);
    expect(asked).toHaveLength(1);
  });

  it('ends when the model asks for tools and names none', async () => {
    const { client, asked } = fakeClient([reply('tool_use', [text('hm')])]);
    const result = await runApi(rig(client).options);
    expect(end(result)).toBe('unexpected');
    expect(asked).toHaveLength(1);
  });

  it('sends thinking blocks back exactly as they came', async () => {
    const content = [
      { type: 'thinking', thinking: 'Let me think.', signature: 'abc123==' },
      { type: 'redacted_thinking', data: 'opaque' },
      use('t1', 'get_session'),
    ];
    const { client, asked } = fakeClient([reply('tool_use', content), reply('end_turn', [])]);
    await runApi(rig(client).options);
    const messages = asked[1]?.messages as { role: string; content: unknown }[];
    expect(messages[1]).toEqual({ role: 'assistant', content });
  });

  it('says the cost may be higher when the answering model is not in the price table', async () => {
    const { client } = fakeClient([reply('end_turn', [], undefined, 'claude-mystery-9')]);
    const result = await runApi(rig(client).options);
    expect(end(result)).toBe('model-changed');
    expect(result.costMayBeHigher).toBe(true);
    // Priced as the model that was asked for.
    expect(result.costUsd).toBeCloseTo(
      costOf(MODEL, { input: 100, output: 50, cacheWrite: 0, cacheRead: 0 }),
      12,
    );
  });

  it('says the cost may be higher when a response gives no token counts', async () => {
    for (const usage of [
      {},
      { input_tokens: 5 },
      { output_tokens: 5 },
      { input_tokens: '5', output_tokens: 5 },
    ]) {
      const { client } = fakeClient([reply('end_turn', [], usage as Usage)]);
      const result = await runApi(rig(client).options);
      expect(end(result)).toBe('done');
      expect(result.costMayBeHigher).toBe(true);
    }
    const { client } = fakeClient([reply('end_turn', [], { input_tokens: 0, output_tokens: 0 })]);
    expect((await runApi(rig(client).options)).costMayBeHigher).toBe(false);
  });

  it('ends when the answer comes from another model than the one asked for', async () => {
    const { client, asked } = fakeClient([
      reply('tool_use', [use('t', 'get_session')], undefined, 'claude-opus-5-5'),
    ]);
    const r = rig(client);
    const result = await runApi(r.options);
    expect(end(result)).toBe('model-changed');
    expect(r.calls).toEqual([]);
    expect(asked).toHaveLength(1);
    // It was still paid for, at the price of the model that answered.
    expect(result.costUsd).toBeCloseTo(
      costOf('claude-opus-5-5', { input: 100, output: 50, cacheWrite: 0, cacheRead: 0 }),
      12,
    );
  });
});

describe('the request', () => {
  it('has the shape the plan gives', async () => {
    const { client, asked } = fakeClient([reply('end_turn', [])]);
    await runApi(rig(client, { effort: 'high', model: 'claude-haiku-5-5' }).options);
    const sent = asked[0] as Record<string, unknown>;
    expect(sent.model).toBe('claude-haiku-5-5');
    expect(sent.max_tokens).toBe(API_MAX_TOKENS);
    expect(sent.output_config).toEqual({ effort: 'high' });
    expect('thinking' in sent).toBe(false);
    expect(sent.tool_choice).toEqual({ type: 'auto' });
    expect(sent.cache_control).toEqual({ type: 'ephemeral' });
    expect(sent.system).toEqual([
      { type: 'text', text: RESEARCH_PROMPT, cache_control: { type: 'ephemeral' } },
    ]);
    const tools = sent.tools as { name: string; input_schema: { type: string } }[];
    expect(tools.map((tool) => tool.name)).toEqual(AI_TOOL_NAMES);
    expect(tools.every((tool) => tool.input_schema.type === 'object')).toBe(true);
    expect(sent.messages).toEqual([{ role: 'user', content: API_FIRST_MESSAGE }]);
  });

  it('puts no tree data in the first message', () => {
    expect(API_FIRST_MESSAGE).toContain('get_session');
    expect(API_FIRST_MESSAGE.length).toBeLessThan(200);
  });
});

describe('errors', () => {
  it.each([
    [401, 'key-refused'],
    [403, 'key-forbidden'],
    [429, 'rate-limited'],
    [529, 'overloaded'],
    [500, 'overloaded'],
    [400, 'failed'],
  ] as const)('maps an HTTP %i to %s without a second request', async (status, why) => {
    const { client, asked } = fakeClient([statusError(status)]);
    const result = await runApi(rig(client).options);
    expect(end(result)).toBe(why);
    expect(asked).toHaveLength(1);
    expect(result.responses).toBe(0);
  });

  it('does not say the cost may be higher after a refused key', async () => {
    const { client } = fakeClient([statusError(401)]);
    expect((await runApi(rig(client).options)).costMayBeHigher).toBe(false);
  });

  it('maps a timeout, and says the cost may be higher', async () => {
    const { client } = fakeClient([new Anthropic.APIConnectionTimeoutError()]);
    const result = await runApi(rig(client).options);
    expect(end(result)).toBe('timeout');
    expect(result.costMayBeHigher).toBe(true);
  });

  it('maps a network error, and says the cost may be higher', async () => {
    const { client } = fakeClient([
      new Anthropic.APIConnectionError({ message: 'getaddrinfo ENOTFOUND', cause: new Error('x') }),
    ]);
    const result = await runApi(rig(client).options);
    expect(end(result)).toBe('network');
    expect(result.costMayBeHigher).toBe(true);
  });

  it('maps anything else to failed', async () => {
    const { client } = fakeClient([new Error('strange')]);
    expect(end(await runApi(rig(client).options))).toBe('failed');
  });

  it('never lets the key, or the text of an error, into progress', async () => {
    const leaky = statusError(401, `Invalid x-api-key ${CANARY} in request headers`);
    (leaky as unknown as { headers: Headers }).headers = new Headers({ 'x-api-key': CANARY });
    const { client } = fakeClient([leaky]);
    const r = rig(client);
    const result = await runApi(r.options);
    expect(end(result)).toBe('key-refused');
    expect(JSON.stringify([result, r.progress, r.busy])).not.toContain(CANARY);
    expect(JSON.stringify(result)).not.toContain('Invalid');
  });

  it('does not let the text of a tool failure end up in an end', async () => {
    const { client } = fakeClient([reply('tool_use', [use('t', 'get_session')])]);
    const r = rig(client, {
      call: async () => {
        throw new Error(`broken ${CANARY}`);
      },
    });
    const result = await runApi(r.options);
    expect(end(result)).toBe('failed');
    expect(JSON.stringify([result, r.progress])).not.toContain(CANARY);
  });
});

describe('Stop and the end of the session', () => {
  it('cuts a request under way, marks the cost, and asks nothing more', async () => {
    const waiting = (_params: unknown, signal: AbortSignal): Promise<unknown> =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Anthropic.APIUserAbortError()));
      });
    const { client, asked } = fakeClient([waiting, reply('end_turn', [])]);
    const r = rig(client);
    const running = runApi(r.options);
    await vi.waitFor(() => expect(asked).toHaveLength(1));
    r.stop();
    const result = await running;
    expect(end(result)).toBe('stopped');
    expect(result.costMayBeHigher).toBe(true);
    expect(asked).toHaveLength(1);
    expect(r.busy).toEqual([true, false]);
  });

  it('ends as session-ended when the session is gone and the request is cut', async () => {
    let current = true;
    const waiting = (_params: unknown, signal: AbortSignal): Promise<unknown> =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Anthropic.APIUserAbortError()));
      });
    const { client } = fakeClient([waiting]);
    const r = rig(client, { isCurrent: () => current });
    const running = runApi(r.options);
    await Promise.resolve();
    current = false;
    r.stop();
    const result = await running;
    expect(end(result)).toBe('session-ended');
    expect(result.costMayBeHigher).toBe(true);
  });

  it('asks nothing when Stop came before the first request', async () => {
    const { client, asked } = fakeClient([reply('end_turn', [])]);
    const r = rig(client);
    r.stop();
    const result = await runApi(r.options);
    expect(end(result)).toBe('stopped');
    expect(asked).toHaveLength(0);
    expect(result.costMayBeHigher).toBe(false);
  });

  it('makes no further tool call and no further request when the run stops being current during a tool call', async () => {
    let current = true;
    const { client, asked } = fakeClient([
      reply('tool_use', [use('a', 'get_session'), use('b', 'list_sources')]),
      reply('end_turn', []),
    ]);
    const r = rig(client, {
      isCurrent: () => current,
      call: async (name) => {
        r.calls.push({ name, input: {} });
        current = false;
        return ok();
      },
    });
    const result = await runApi(r.options);
    expect(end(result)).toBe('session-ended');
    expect(r.calls.map((c) => c.name)).toEqual(['get_session']);
    expect(asked).toHaveLength(1);
    expect(result.costMayBeHigher).toBe(false);
  });

  it('ends without a further tool call when Stop comes during a tool call', async () => {
    const { client, asked } = fakeClient([
      reply('tool_use', [use('a', 'get_session'), use('b', 'list_sources')]),
    ]);
    const r = rig(client, {
      call: async (name) => {
        r.calls.push({ name, input: {} });
        r.stop();
        return ok();
      },
    });
    const result = await runApi(r.options);
    expect(end(result)).toBe('stopped');
    expect(r.calls).toHaveLength(1);
    expect(asked).toHaveLength(1);
  });

  it('does not start a tool call from an answer that arrives after the session ended', async () => {
    let current = true;
    const late = (): unknown => {
      current = false;
      return reply('tool_use', [use('a', 'get_session')]);
    };
    const { client } = fakeClient([late]);
    const r = rig(client, { isCurrent: () => current });
    const result = await runApi(r.options);
    expect(end(result)).toBe('session-ended');
    expect(r.calls).toEqual([]);
    // The answer arrived and was paid for, so it is counted.
    expect(result.responses).toBe(1);
  });
});

describe('the caps', () => {
  it('ends before a request that could pass the cost cap, and sends nothing', async () => {
    const { client, asked } = fakeClient([reply('end_turn', [])]);
    const r = rig(client, { capUsd: firstRequestReserve(MODEL) - 0.001 });
    const result = await runApi(r.options);
    expect(end(result)).toBe('cap-cost');
    expect(asked).toHaveLength(0);
    expect(r.busy).toEqual([]);
  });

  it('lets the first request go when the cap is just above its reserve', async () => {
    const { client, asked } = fakeClient([reply('end_turn', [])]);
    const result = await runApi(
      rig(client, { capUsd: firstRequestReserve(MODEL) + 0.001 }).options,
    );
    expect(end(result)).toBe('done');
    expect(asked).toHaveLength(1);
  });

  it('works the reserve of the first request from the system, the tools and the first message', () => {
    for (const model of Object.keys(MODEL_PRICES) as ApiModel[]) {
      const price = MODEL_PRICES[model];
      const outputPart = (API_MAX_TOKENS * price.output) / 1_000_000;
      const reserve = firstRequestReserve(model);
      expect(reserve).toBeGreaterThan(outputPart);
      const inputTokens = ((reserve - outputPart) * 1_000_000) / (1.25 * price.input);
      // The tools and the research instructions are some thousands of tokens.
      expect(inputTokens).toBeGreaterThan(RESEARCH_PROMPT.length / 2);
      expect(inputTokens).toBeLessThan(100_000);
    }
    expect(firstRequestReserve('claude-opus-5-5')).toBeGreaterThan(
      firstRequestReserve('claude-haiku-5-5'),
    );
  });

  it('works the reserve of a later request from the last response and the new tool results', async () => {
    const usage = {
      input_tokens: 1000,
      output_tokens: 300,
      cache_creation_input_tokens: 200,
      cache_read_input_tokens: 500,
    };
    const toolValue = 'x'.repeat(1000);
    const spent = costOf(MODEL, { input: 1000, output: 300, cacheWrite: 200, cacheRead: 500 });
    const resultChars = JSON.stringify(ok(toolValue)).length;
    const nextInput = 1000 + 200 + 500 + 300 + Math.ceil(resultChars / 2);
    const price = MODEL_PRICES[MODEL];
    const reserve = (nextInput * 1.25 * price.input + API_MAX_TOKENS * price.output) / 1_000_000;

    const steps = (): Step[] => [
      reply('tool_use', [use('t', 'get_session')], usage),
      reply('end_turn', []),
    ];
    // A hair below what the second request could cost: it is not sent.
    const below = fakeClient(steps());
    const stopped = await runApi(
      rig(below.client, { capUsd: spent + reserve - 1e-9, call: async () => ok(toolValue) })
        .options,
    );
    expect(end(stopped)).toBe('cap-cost');
    expect(below.asked).toHaveLength(1);
    expect(stopped.costUsd).toBeCloseTo(spent, 12);
    // A hair above: it is.
    const above = fakeClient(steps());
    const went = await runApi(
      rig(above.client, { capUsd: spent + reserve + 1e-9, call: async () => ok(toolValue) })
        .options,
    );
    expect(end(went)).toBe('done');
    expect(above.asked).toHaveLength(2);
  });

  it('adds up tokens by kind and prices cache writes and reads', async () => {
    const { client } = fakeClient([
      reply('tool_use', [use('t', 'get_session')], {
        input_tokens: 10,
        output_tokens: 20,
        cache_creation_input_tokens: 30,
        cache_read_input_tokens: 40,
      }),
      reply('end_turn', [], { input_tokens: 1, output_tokens: 2 }),
    ]);
    const result = await runApi(rig(client).options);
    expect(result.usage).toEqual({ input: 11, output: 22, cacheWrite: 30, cacheRead: 40 });
    expect(result.costUsd).toBeCloseTo(
      costOf(MODEL, { input: 11, output: 22, cacheWrite: 30, cacheRead: 40 }),
      12,
    );
  });

  it('ends after the most responses a run may take', async () => {
    const steps: Step[] = Array.from({ length: API_MAX_RESPONSES + 2 }, (_v, i) =>
      reply('tool_use', [use(`t${i}`, 'get_session')], { input_tokens: 1, output_tokens: 1 }),
    );
    const { client, asked } = fakeClient(steps);
    const r = rig(client, { capUsd: 10 });
    const result = await runApi(r.options);
    expect(end(result)).toBe('cap-responses');
    expect(asked).toHaveLength(API_MAX_RESPONSES);
    expect(result.responses).toBe(API_MAX_RESPONSES);
  });

  it('ends when the run has lasted too long, between requests', async () => {
    let clock = 0;
    const { client, asked } = fakeClient([
      reply('tool_use', [use('t', 'get_session')]),
      reply('end_turn', []),
    ]);
    const r = rig(client, {
      now: () => clock,
      call: async () => {
        clock = API_RUN_MS + 1;
        return ok();
      },
    });
    const result = await runApi(r.options);
    expect(end(result)).toBe('cap-time');
    expect(asked).toHaveLength(1);
  });

  it('ends when the time is up before the first request', async () => {
    let clock = 0;
    const { client, asked } = fakeClient([reply('end_turn', [])]);
    const r = rig(client, { now: () => clock });
    clock = 0;
    const early = await runApi({ ...r.options, now: () => (clock += API_RUN_MS) });
    expect(end(early)).toBe('cap-time');
    expect(asked).toHaveLength(0);
  });

  it('cuts a request still under way when the time is up, and marks the cost', async () => {
    vi.useFakeTimers();
    try {
      const waiting = (_params: unknown, signal: AbortSignal): Promise<unknown> =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Anthropic.APIUserAbortError()));
        });
      const { client } = fakeClient([waiting]);
      const running = runApi(rig(client).options);
      await vi.advanceTimersByTimeAsync(API_RUN_MS + 1);
      const result = await running;
      expect(end(result)).toBe('cap-time');
      expect(result.costMayBeHigher).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

interface Seen {
  headers: IncomingHttpHeaders;
  body: Record<string, unknown>;
  url: string | undefined;
}

describe('makeApiClient with the real SDK against a local server', () => {
  const servers: Server[] = [];
  const saved = new Map<string, string | undefined>();

  afterEach(async () => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    saved.clear();
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
          }),
      ),
    );
  });

  function setEnv(name: string, value: string): void {
    if (!saved.has(name)) saved.set(name, process.env[name]);
    process.env[name] = value;
  }

  async function listen(
    handler: (seen: Seen, respond: (status: number, body: unknown) => void) => void,
  ): Promise<{ url: string; seen: Seen[]; closed: () => number }> {
    const seen: Seen[] = [];
    let closed = 0;
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      res.on('close', () => (closed += 1));
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const one: Seen = {
          headers: req.headers,
          body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<
            string,
            unknown
          >,
          url: req.url,
        };
        seen.push(one);
        handler(one, (status, body) => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(body));
        });
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return { url: `http://127.0.0.1:${port}`, seen, closed: () => closed };
  }

  const fine = reply('end_turn', [text('From the server.')], {
    input_tokens: 10,
    output_tokens: 5,
  });

  it('sends the request the plan describes, with the key, whatever the environment says', async () => {
    const other = await listen((_seen, respond) => respond(200, fine));
    const target = await listen((_seen, respond) => respond(200, fine));
    setEnv('ANTHROPIC_BASE_URL', other.url);
    setEnv('ANTHROPIC_AUTH_TOKEN', 'token-from-the-environment');
    setEnv('ANTHROPIC_API_KEY', 'sk-ant-from-the-environment');
    setEnv('ANTHROPIC_LOG', 'debug');
    const noise = [
      vi.spyOn(console, 'log').mockImplementation(() => undefined),
      vi.spyOn(console, 'debug').mockImplementation(() => undefined),
      vi.spyOn(console, 'info').mockImplementation(() => undefined),
      vi.spyOn(console, 'warn').mockImplementation(() => undefined),
    ];

    const client = makeApiClient(CANARY, globalThis.fetch, target.url);
    const r = rig(client, { effort: 'low' });
    const result = await runApi(r.options);

    expect(end(result)).toBe('done');
    expect(result.text).toBe('From the server.');
    expect(other.seen).toHaveLength(0);
    expect(target.seen).toHaveLength(1);
    const sent = target.seen[0] as Seen;
    expect(sent.url).toBe('/v1/messages');
    // The SDK sends an API key as a bearer token; nothing from the environment replaces it.
    expect(sent.headers.authorization).toBe(`Bearer ${CANARY}`);
    expect(sent.headers['x-api-key']).toBeUndefined();
    expect(sent.body.model).toBe(MODEL);
    expect(sent.body.max_tokens).toBe(API_MAX_TOKENS);
    expect(sent.body.output_config).toEqual({ effort: 'low' });
    expect('thinking' in sent.body).toBe(false);
    expect(sent.body.tool_choice).toEqual({ type: 'auto' });
    expect(sent.body.cache_control).toEqual({ type: 'ephemeral' });
    expect(sent.body.system).toEqual([
      { type: 'text', text: RESEARCH_PROMPT, cache_control: { type: 'ephemeral' } },
    ]);
    expect((sent.body.tools as { name: string }[]).map((tool) => tool.name)).toEqual(AI_TOOL_NAMES);
    expect(sent.body.messages).toEqual([{ role: 'user', content: API_FIRST_MESSAGE }]);
    for (const spy of noise) expect(spy).not.toHaveBeenCalled();
  });

  it('does not retry a failed request, and keeps the key and the server text out of the result', async () => {
    const target = await listen((seen, respond) =>
      respond(401, {
        type: 'error',
        error: {
          type: 'authentication_error',
          message: `invalid key ${String(seen.headers.authorization)}`,
        },
      }),
    );
    const client = makeApiClient(CANARY, globalThis.fetch, target.url);
    const r = rig(client);
    const result = await runApi(r.options);
    expect(end(result)).toBe('key-refused');
    expect(target.seen).toHaveLength(1);
    expect(JSON.stringify([result, r.progress])).not.toContain(CANARY);
  });

  it('sends the saved key whatever ANTHROPIC_CUSTOM_HEADERS says', async () => {
    const target = await listen((_seen, respond) => respond(200, fine));
    setEnv(
      'ANTHROPIC_CUSTOM_HEADERS',
      [
        'Authorization: Bearer key-of-another-account',
        'X-Api-Key: key-of-another-account',
        'X-Extra: hello',
      ].join(String.fromCharCode(10)),
    );
    const result = await runApi(rig(makeApiClient(CANARY, globalThis.fetch, target.url)).options);
    expect(end(result)).toBe('done');
    const sent = target.seen[0] as Seen;
    expect(sent.headers.authorization).toBe(`Bearer ${CANARY}`);
    expect(sent.headers['x-api-key']).toBeUndefined();
  });

  it('refuses a request to another origin before it is sent', async () => {
    const inner = vi.fn(async () => new Response('{}'));
    const guarded = guardedFetch(CANARY, inner, 'https://api.anthropic.com');
    await expect(guarded('https://example.com/v1/messages', {})).rejects.toThrow();
    await expect(guarded('http://api.anthropic.com/v1/messages', {})).rejects.toThrow();
    expect(inner).not.toHaveBeenCalled();
    await guarded('https://api.anthropic.com/v1/messages', {
      headers: { 'X-Api-Key': 'other', Authorization: 'Bearer other' },
    });
    expect(inner).toHaveBeenCalledTimes(1);
    const init = (inner.mock.calls[0] as unknown as [unknown, RequestInit])[1];
    const headers = new Headers(init.headers);
    expect(headers.get('authorization')).toBe(`Bearer ${CANARY}`);
    expect(headers.get('x-api-key')).toBeNull();
  });

  it('maps a 529 from the server to overloaded without a retry', async () => {
    const target = await listen((_seen, respond) =>
      respond(529, { type: 'error', error: { type: 'overloaded_error', message: 'busy' } }),
    );
    const result = await runApi(rig(makeApiClient(CANARY, globalThis.fetch, target.url)).options);
    expect(end(result)).toBe('overloaded');
    expect(target.seen).toHaveLength(1);
  });

  it('stops a request under way when the run is aborted', async () => {
    const target = await listen(() => {
      // Never answers.
    });
    const client = makeApiClient(CANARY, globalThis.fetch, target.url);
    const r = rig(client);
    const running = runApi(r.options);
    await vi.waitFor(() => expect(target.seen).toHaveLength(1));
    r.stop();
    const result = await running;
    expect(end(result)).toBe('stopped');
    expect(result.costMayBeHigher).toBe(true);
    await vi.waitFor(() => expect(target.closed()).toBe(1));
    expect(target.seen).toHaveLength(1);
  });

  it('runs a tool turn end to end over HTTP', async () => {
    let n = 0;
    const target = await listen((_seen, respond) => {
      n += 1;
      respond(
        200,
        n === 1
          ? reply('tool_use', [use('toolu_1', 'search_tree', { query: 'Ann' })], {
              input_tokens: 10,
              output_tokens: 5,
            })
          : fine,
      );
    });
    const r = rig(makeApiClient(CANARY, globalThis.fetch, target.url));
    const result = await runApi(r.options);
    expect(end(result)).toBe('done');
    expect(r.calls).toEqual([{ name: 'search_tree', input: { query: 'Ann' } }]);
    const messages = (target.seen[1] as Seen).body.messages as { role: string }[];
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
  });
});
