import {
  API_METHODS,
  type ApiMethod,
  type IpcErrorCode,
  type IpcResult,
  type RulzApi,
} from '../../shared/ipc';

/** A call to the main process that did not succeed. `code` says what kind of failure it was. */
export class ApiError extends Error {
  readonly code: IpcErrorCode;

  constructor(code: IpcErrorCode, message: string) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
  }
}

async function invoke(method: ApiMethod, args: unknown[]): Promise<unknown> {
  const bridge = window.rulz;
  if (!bridge) {
    throw new ApiError('failed', 'This page must be opened inside the RulZ Ancestry app.');
  }
  const call = bridge[method] as (...values: unknown[]) => Promise<IpcResult<unknown>>;
  const result = await call(...args);
  if (!result.ok) throw new ApiError(result.error.code, result.error.message);
  return result.value;
}

/**
 * The main process's functions. Each returns its value directly and throws an
 * {@link ApiError} on failure, so screens use ordinary `try` and `catch`.
 */
export const api = Object.fromEntries(
  API_METHODS.map((method) => [method, (...args: unknown[]) => invoke(method, args)]),
) as unknown as RulzApi;

/** An error as a sentence to show: capital first letter, full stop at the end. */
export function errorMessage(error: unknown): string {
  const text = (error instanceof Error ? error.message : String(error)).trim();
  if (text === '') return 'Something went wrong.';
  const sentence = text.charAt(0).toUpperCase() + text.slice(1);
  return /[.!?]$/.test(sentence) ? sentence : `${sentence}.`;
}
