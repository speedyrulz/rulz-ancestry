import Anthropic, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIUserAbortError,
} from '@anthropic-ai/sdk';
import {
  API_MAX_TOKENS,
  API_MODELS,
  CACHE_WRITE_FACTOR,
  MODEL_PRICES,
  RESEARCH_PROMPT,
  aiToolSpecs,
  costOf,
  type AiToolResult,
  type ApiEffort,
  type ApiModel,
  type ApiUsage,
} from '@rulz/ai';
import type { AiApiEnd, AiApiProgress } from '../shared/ipc';

export type { AiApiEnd, AiApiProgress };

/**
 * Route C of the AI assistant: the app itself asks Anthropic, with a key the
 * user pasted, and works the same eight tools as every other route. This
 * file is the loop. It imports no Electron: the session hands it the door
 * (`call`), the key's client and the clock, so tests run it with fakes.
 *
 * The loop is written by hand with `messages.create`, not streaming and not
 * the SDK's tool runner: a response of at most {@link API_MAX_TOKENS} tokens
 * fits inside the SDK's timeouts, and a whole response is easy to cap, abort
 * and account for.
 *
 * What it keeps to:
 * - Every tool call goes through `call`, one after another. This file reaches
 *   no tree, no source and no file.
 * - Before each request it works out the most the request could cost and ends
 *   the run if that would pass the cap. It does not wait to find out after.
 * - After every `await` it checks the run is still wanted (`signal`,
 *   `isCurrent`), so a late answer never starts another request or tool call
 *   for a session that has ended or been replaced.
 * - It never repeats a request: a retry could be billed twice and the app
 *   could not count it. An overload or a rate limit ends the run.
 * - No error object or error text of the SDK leaves it, because those can
 *   carry request headers. Every end has a fixed word.
 * - The key is given to the SDK client and to nothing else.
 * - The model's own words are kept as text only, never its thinking.
 */

/** Where the app's requests go. The built app always uses this. */
export const API_BASE_URL = 'https://api.anthropic.com';

/** The most responses one run may take. */
export const API_MAX_RESPONSES = 30;

/** The longest one run may last, in milliseconds. */
export const API_RUN_MS = 20 * 60 * 1000;

/** How long one request may take, in milliseconds. */
export const API_REQUEST_MS = 5 * 60 * 1000;

/** The most of the model's own text a run keeps, in characters. */
export const API_TEXT_MAX = 20_000;

/**
 * The first thing the model is told. It holds nothing of the tree: what the
 * session is for comes from `get_session`, as a tool answer.
 */
export const API_FIRST_MESSAGE =
  'A research session was started in RulZ Kinspora. Begin with get_session, then follow the research instructions.';

/** How many characters of text are counted as one token when a request is only estimated. */
const CHARS_PER_TOKEN = 2;

/** The part of Anthropic's client the loop needs. Tests pass a fake. */
export interface AiApiClient {
  messages: { create(params: unknown, options: { signal: AbortSignal }): Promise<unknown> };
}

/**
 * Wraps the fetch the SDK is given so that two things hold whatever the SDK
 * or the environment does. The SDK merges `ANTHROPIC_CUSTOM_HEADERS` into its
 * headers after its own, so a header set there could replace the saved key.
 * So every request (a) goes only to the origin of `baseURL`, and (b) carries
 * the saved key as its bearer token and no `x-api-key`.
 */
export function guardedFetch(
  key: string,
  inner: typeof globalThis.fetch,
  baseURL: string,
): typeof globalThis.fetch {
  const origin = new URL(baseURL).origin;
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (new URL(url).origin !== origin)
      throw new Error('A request to another address was refused.');
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    headers.set('authorization', `Bearer ${key}`);
    headers.delete('x-api-key');
    return inner(input, { ...init, headers });
  };
}

/**
 * Anthropic's client for one run. The key, the address and the way to fetch
 * are all given here, so nothing in the environment (`ANTHROPIC_API_KEY`,
 * `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_LOG`, a profile
 * on disk) can change which key is used, where it goes or what is logged.
 * Only a test passes `baseURL`; the app leaves it out.
 */
export function makeApiClient(
  key: string,
  fetch: typeof globalThis.fetch,
  baseURL: string = API_BASE_URL,
): AiApiClient {
  const client = new Anthropic({
    apiKey: key,
    authToken: null,
    baseURL,
    logLevel: 'off',
    maxRetries: 0,
    timeout: API_REQUEST_MS,
    openTelemetry: false,
    fetch: guardedFetch(key, fetch, baseURL),
  });
  return {
    messages: {
      create: (params, options) =>
        client.messages.create(params as Anthropic.MessageCreateParamsNonStreaming, options),
    },
  };
}

export interface AiApiRunOptions {
  client: AiApiClient;
  /** The door bound to this run: every tool call goes through it. */
  call: (name: string, input: unknown) => Promise<AiToolResult>;
  /** Aborts on Stop of the run and on the session's end. */
  signal: AbortSignal;
  /** False once this run is no longer the session's current run. */
  isCurrent: () => boolean;
  model: ApiModel;
  effort: ApiEffort;
  capUsd: number;
  /** The clock, for the run's time limit. Tests pass a fake. */
  now: () => number;
  onProgress: (progress: AiApiProgress) => void;
  /** True while a request is in flight (the session counts it as activity). */
  onRequest: (busy: boolean) => void;
}

/** The tools as Anthropic takes them, in a fixed order. */
function requestTools(): { name: string; description: string; input_schema: unknown }[] {
  return aiToolSpecs().map((spec) => ({
    name: spec.name,
    description: spec.description,
    input_schema: spec.inputSchema,
  }));
}

/** The research instructions as one cached system block. */
function requestSystem(): { type: 'text'; text: string; cache_control: { type: 'ephemeral' } }[] {
  return [{ type: 'text', text: RESEARCH_PROMPT, cache_control: { type: 'ephemeral' } }];
}

/** The most a request can cost, in dollars: its input as if it were all written to the cache, and a full response. */
function reserveOf(model: ApiModel, inputTokens: number): number {
  const price = MODEL_PRICES[model];
  return (
    (inputTokens * CACHE_WRITE_FACTOR * price.input + API_MAX_TOKENS * price.output) / 1_000_000
  );
}

function firstInputEstimate(): number {
  const chars =
    JSON.stringify(requestSystem()).length +
    JSON.stringify(requestTools()).length +
    API_FIRST_MESSAGE.length;
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/** What the first request could cost, in dollars: the start refuses a cap below this. */
export function firstRequestReserve(model: ApiModel): number {
  return reserveOf(model, firstInputEstimate());
}

const NO_USAGE: ApiUsage = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/** What went wrong with a request, as an end and whether Anthropic may still bill the request. */
function endOfError(error: unknown): { end: AiApiEnd; mayBill: boolean } {
  // Only the kind of error is read, never its text or its object: those can
  // carry request headers.
  const status = isRecord(error) && typeof error.status === 'number' ? error.status : undefined;
  if (error instanceof APIConnectionTimeoutError) return { end: 'timeout', mayBill: true };
  if (error instanceof APIUserAbortError) return { end: 'stopped', mayBill: true };
  if (error instanceof APIConnectionError) return { end: 'network', mayBill: true };
  if (status === 401) return { end: 'key-refused', mayBill: false };
  if (status === 403) return { end: 'key-forbidden', mayBill: false };
  if (status === 429) return { end: 'rate-limited', mayBill: false };
  if (status === 529) return { end: 'overloaded', mayBill: false };
  if (status !== undefined && status >= 500) return { end: 'overloaded', mayBill: true };
  if (status !== undefined) return { end: 'failed', mayBill: false };
  // A failure with neither a name nor a status happened somewhere between
  // the request and its answer.
  return { end: 'failed', mayBill: true };
}

/**
 * Works one run: asks the model, runs the tools it names through the door,
 * and sends their answers back, until the model is done or a cap or an end
 * stops it. Resolves with the last progress; never rejects.
 */
export async function runApi(options: AiApiRunOptions): Promise<AiApiProgress> {
  const { client, call, isCurrent, model, effort, capUsd, now, onRequest } = options;
  const started = now();
  const progress: AiApiProgress = {
    responses: 0,
    usage: { ...NO_USAGE },
    costUsd: 0,
    costMayBeHigher: false,
    lastTool: null,
    text: '',
    ended: null,
  };

  // The run's own limit of time is also a timer, so that a request still
  // under way when the time is up is cut off. The signal of the run and the
  // timer end up in one.
  const inner = new AbortController();
  let timedOut = false;
  const onAbort = (): void => inner.abort();
  if (options.signal.aborted) inner.abort();
  else options.signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    inner.abort();
  }, API_RUN_MS);

  const emit = (): void => {
    options.onProgress({ ...progress, usage: { ...progress.usage } });
  };

  /** Why the run is no longer wanted, or null while it is. */
  const unwanted = (): AiApiEnd | null => {
    if (!isCurrent()) return 'session-ended';
    if (options.signal.aborted) return 'stopped';
    if (timedOut || now() - started >= API_RUN_MS) return 'cap-time';
    return null;
  };

  const finish = (end: AiApiEnd): AiApiProgress => {
    progress.ended = end;
    emit();
    return { ...progress, usage: { ...progress.usage } };
  };

  const system = requestSystem();
  const tools = requestTools();
  const messages: unknown[] = [{ role: 'user', content: API_FIRST_MESSAGE }];
  let nextInput = firstInputEstimate();

  try {
    for (;;) {
      const stop = unwanted();
      if (stop) return finish(stop);
      if (progress.responses >= API_MAX_RESPONSES) return finish('cap-responses');
      if (progress.costUsd + reserveOf(model, nextInput) > capUsd) return finish('cap-cost');

      const params = {
        model,
        max_tokens: API_MAX_TOKENS,
        output_config: { effort },
        tool_choice: { type: 'auto' },
        tools,
        system,
        cache_control: { type: 'ephemeral' },
        messages: [...messages],
      };

      let response: unknown;
      onRequest(true);
      try {
        response = await client.messages.create(params, { signal: inner.signal });
      } catch (error) {
        const later = unwanted();
        // A request cut off by Stop, the time limit or the session's end was
        // sent, and Anthropic may bill it.
        if (later) {
          progress.costMayBeHigher = true;
          return finish(later);
        }
        const { end, mayBill } = endOfError(error);
        if (mayBill) progress.costMayBeHigher = true;
        return finish(end);
      } finally {
        onRequest(false);
      }

      // The answer arrived: count it whatever happens next.
      const answer = isRecord(response) ? response : {};
      const usage = isRecord(answer.usage) ? answer.usage : {};
      const asked = progress.usage;
      const thisUsage: ApiUsage = {
        input: count(usage.input_tokens),
        output: count(usage.output_tokens),
        cacheWrite: count(usage.cache_creation_input_tokens),
        cacheRead: count(usage.cache_read_input_tokens),
      };
      progress.responses += 1;
      progress.usage = {
        input: asked.input + thisUsage.input,
        output: asked.output + thisUsage.output,
        cacheWrite: asked.cacheWrite + thisUsage.cacheWrite,
        cacheRead: asked.cacheRead + thisUsage.cacheRead,
      };
      const priced = API_MODELS.find((one) => one === answer.model);
      progress.costUsd += costOf(priced ?? model, thisUsage);
      // A model that is not in the table was priced as the one asked for, and
      // a response that does not say how many tokens it used was counted as
      // none: either way the figure may be too low.
      if (
        priced === undefined ||
        typeof usage.input_tokens !== 'number' ||
        typeof usage.output_tokens !== 'number'
      ) {
        progress.costMayBeHigher = true;
      }

      const content = Array.isArray(answer.content) ? (answer.content as unknown[]) : [];
      for (const block of content) {
        if (!isRecord(block) || block.type !== 'text' || typeof block.text !== 'string') continue;
        const room = API_TEXT_MAX - progress.text.length;
        if (room <= 0) break;
        const joined = progress.text === '' ? block.text : `\n\n${block.text}`;
        progress.text += joined.slice(0, room);
      }
      emit();

      if (answer.model !== model) return finish('model-changed');
      const after = unwanted();
      if (after) return finish(after);

      switch (answer.stop_reason) {
        case 'end_turn':
          return finish('done');
        case 'refusal':
          return finish('declined');
        case 'max_tokens':
          return finish('max-tokens');
        case 'pause_turn':
          return finish('paused');
        case 'tool_use':
          break;
        default:
          return finish('unexpected');
      }

      const uses = content.filter(
        (block): block is Record<string, unknown> => isRecord(block) && block.type === 'tool_use',
      );
      if (uses.length === 0) return finish('unexpected');

      const results: unknown[] = [];
      let resultChars = 0;
      for (const use of uses) {
        const before = unwanted();
        if (before) return finish(before);
        const name = typeof use.name === 'string' ? use.name : '';
        progress.lastTool = name;
        emit();
        const result = await call(name, use.input);
        const text = JSON.stringify(result);
        resultChars += text.length;
        results.push({
          type: 'tool_result',
          tool_use_id: use.id,
          content: text,
          ...(result.ok ? {} : { is_error: true }),
        });
        const done = unwanted();
        if (done) return finish(done);
      }

      // The assistant's turn goes back as it came, thinking blocks included.
      messages.push({ role: 'assistant', content: answer.content });
      messages.push({ role: 'user', content: results });
      // What the next request holds, as far as it can be known: all of this
      // one's input and answer, and the new tool answers.
      nextInput =
        thisUsage.input +
        thisUsage.cacheWrite +
        thisUsage.cacheRead +
        thisUsage.output +
        Math.ceil(resultChars / CHARS_PER_TOKEN);
    }
  } catch {
    // The door or the loop itself failed. Nothing of the error is kept.
    return finish(unwanted() ?? 'failed');
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener('abort', onAbort);
  }
}
