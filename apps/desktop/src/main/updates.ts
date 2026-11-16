import type { UpdateMethod } from '../shared/updates';
import type { ApiHandlers } from './handlers';

/** The handlers of the functions in `shared/updates.ts` (part 6.4). */
export type UpdateHandlers = Pick<ApiHandlers, UpdateMethod>;

export function createUpdateHandlers(): UpdateHandlers {
  return {};
}
