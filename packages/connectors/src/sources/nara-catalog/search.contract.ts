import { describe, expect, it } from 'vitest';
import { naraCatalogManifest } from './manifest';
import { naraSearchParams } from './search';

/**
 * Looks at what the National Archives publish about their API, to notice when
 * the search changes. This is not part of the unit tests: it needs the
 * internet, and it runs on its own schedule (`pnpm test:contract`,
 * `.github/workflows/contract.yml`).
 *
 * It sends no search and no key: a key is the user's own and is never put
 * into a test, a file or a workflow. It reads the API's own specification and
 * checks that every parameter the connector sends is still in it.
 */
describe('The National Archives, asked for their specification', () => {
  it('still describes the search with the parameters the connector sends', async () => {
    const answer = await fetch(`${naraCatalogManifest.baseUrl}/swagger.json`, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'RulZAncestry/contract-check (+https://github.com/speedyrulz/rulz-ancestry)',
      },
      signal: AbortSignal.timeout(60_000),
    });
    expect(answer.ok).toBe(true);
    const spec = (await answer.json()) as {
      paths?: Record<string, { get?: { parameters?: unknown[] } }>;
      components?: { parameters?: Record<string, { name?: string; in?: string }> };
    };
    const search = Object.entries(spec.paths ?? {}).find(
      ([path]) => path.trim() === '/records/search',
    )?.[1].get;
    expect(search).toBeDefined();
    // A parameter is written out, or named by a reference to the list of parameters.
    const names = (search?.parameters ?? []).map((entry) => {
      const item = entry as { name?: string; $ref?: string };
      if (item.name !== undefined) return item.name;
      const key = item.$ref?.split('/').pop() ?? '';
      return spec.components?.parameters?.[key]?.name ?? '';
    });
    const sent = Object.keys(
      naraSearchParams(
        { words: 'x', phrase: true, fromYear: null, toYear: null, state: '' },
        { offset: 0, limit: 20 },
      ),
    );
    for (const name of sent) expect(names, name).toContain(name);
    // The key goes in a header, as the specification says.
    expect(JSON.stringify(spec)).toContain(naraCatalogManifest.keyHeader ?? 'no header');
  }, 90_000);
});
