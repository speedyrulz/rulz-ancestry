import { describe, expect, it } from 'vitest';
import { connectorManifestSchema, type ConnectorManifest } from './manifest';
import { getManifest, manifests, manifestsByTier } from './registry';

const valid: ConnectorManifest = {
  id: 'example-source',
  name: 'Example',
  tier: 'api',
  auth: 'none',
  access: 'open',
  baseUrl: 'https://example.org/api',
  rateLimit: { requests: 10, perSeconds: 60, source: 'published' },
  cacheTtlHours: 24,
  mayStoreImages: false,
  attribution: 'Example Archive',
  termsUrl: 'https://example.org/terms',
  docsUrl: 'https://example.org/docs',
  verifiedOn: '2026-11-11',
  notes: [],
};

function issuePaths(input: unknown): string[] {
  const result = connectorManifestSchema.safeParse(input);
  return result.success ? [] : result.error.issues.map((issue) => issue.path.join('.'));
}

describe('connectorManifestSchema', () => {
  it('accepts a complete API manifest', () => {
    expect(issuePaths(valid)).toEqual([]);
  });

  it('requires a rate limit for API connectors', () => {
    const { rateLimit: _omitted, ...withoutLimit } = valid;
    expect(issuePaths(withoutLimit)).toContain('rateLimit');
  });

  it('rejects limits on deep-link sources, which the app never fetches', () => {
    expect(issuePaths({ ...valid, tier: 'deeplink' })).toContain('rateLimit');
  });

  it('rejects a source that needs credentials but claims open access', () => {
    expect(issuePaths({ ...valid, auth: 'apiKey' })).toContain('access');
  });

  it('rejects malformed ids, URLs and dates', () => {
    expect(issuePaths({ ...valid, id: 'Has Spaces' })).toContain('id');
    expect(issuePaths({ ...valid, baseUrl: 'not a url' })).toContain('baseUrl');
    expect(issuePaths({ ...valid, verifiedOn: '11/11/2026' })).toContain('verifiedOn');
  });
});

describe('registry', () => {
  it('contains only manifests that satisfy the schema', () => {
    for (const manifest of manifests) {
      expect(issuePaths(manifest), manifest.id).toEqual([]);
    }
  });

  it('has unique ids and finds a manifest by id', () => {
    const ids = manifests.map((manifest) => manifest.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(getManifest('wikitree')?.name).toBe('WikiTree');
    expect(getManifest('does-not-exist')).toBeUndefined();
  });

  it('groups sources by tier', () => {
    expect(manifestsByTier('deeplink').map((manifest) => manifest.id)).toEqual([
      'find-a-grave',
      'familysearch-records',
    ]);
    expect(manifestsByTier('bulk').length).toBe(2);
  });

  it('knows FamilySearch only as a site to open in the browser', () => {
    // FamilySearch gave the project no access to its API (2026-11-13).
    expect(getManifest('familysearch')).toBeUndefined();
    expect(getManifest('familysearch-records')?.tier).toBe('deeplink');
  });

  it('carries the published limits that were verified', () => {
    expect(getManifest('loc')?.rateLimit).toEqual({
      requests: 20,
      perSeconds: 60,
      source: 'published',
    });
    expect(getManifest('nara-catalog')?.quota).toEqual({ requests: 10_000, period: 'month' });
  });
});
