/**
 * The part of the page's API that tells the user about a new version (part 6.4).
 * It is kept apart from ipc.ts, which lists these names after its own, so that
 * this part can grow without touching that file.
 */
export const UPDATE_METHODS = [] as const;

export type UpdateMethod = (typeof UPDATE_METHODS)[number];

/** The functions named in {@link UPDATE_METHODS}. */
export type UpdateApi = Record<never, never>;
