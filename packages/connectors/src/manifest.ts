import { z } from 'zod';

/**
 * A connector manifest records the technical and legal limits of one data
 * source. The shared HTTP client (Phase 3) reads these values to enforce rate
 * limits, cache lifetimes and attribution, so a connector cannot exceed what
 * its source permits.
 */
export const connectorManifestSchema = z
  .object({
    /** Stable identifier, also stored in the database (`source.connector_id`). */
    id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'lowercase words separated by hyphens'),
    name: z.string().min(1),
    /**
     * api      - queried live through an official API
     * bulk     - an open dataset downloaded and indexed locally as a data pack
     * deeplink - no automated access; the app only opens a prefilled search in the browser
     */
    tier: z.enum(['api', 'bulk', 'deeplink']),
    auth: z.enum(['none', 'apiKey', 'oauth2-pkce']),
    /** What the user or project must obtain before the source can be used. */
    access: z.enum(['open', 'key-required', 'approval-required']),
    baseUrl: z.string().refine((value) => URL.canParse(value), 'must be a valid URL'),
    /**
     * The site the pages of its records are on, where that is another host
     * than `baseUrl` (an API often is). The link of a record must lie on it.
     */
    siteUrl: z
      .string()
      .refine(
        (value) => URL.canParse(value) && new URL(value).protocol === 'https:',
        'must be an HTTPS URL',
      )
      .optional(),
    rateLimit: z
      .object({
        requests: z.number().int().positive(),
        perSeconds: z.number().positive(),
        /** `published` = stated by the source; `self-imposed` = our own conservative choice. */
        source: z.enum(['published', 'self-imposed']),
      })
      .optional(),
    /**
     * How long the source shuts a client out that asked too often, in
     * seconds. The source is left alone for this long at least after it
     * answers "too many requests", "forbidden", or with a web page in place
     * of an answer. The client's own pause when absent.
     */
    pauseSeconds: z.number().int().positive().optional(),
    /**
     * How long the source is given to answer, in seconds, when it is known to
     * take longer than most. The client's own time when absent.
     */
    timeoutSeconds: z.number().int().positive().max(180).optional(),
    /** The request header a key is sent in, for a source that needs one. A key is never put into an address. */
    keyHeader: z
      .string()
      .regex(/^[a-z][a-z0-9-]{0,40}$/, 'a header name in small letters')
      .optional(),
    /**
     * False when the source's terms bar keeping what it returns. Nothing of an
     * answer is then written into a tree: a citation holds the record's
     * identifier and its address, which the app makes itself. Absent means it may.
     */
    mayStoreText: z.boolean().optional(),
    /** A hard cap per key over a longer period, when the source states one. */
    quota: z
      .object({
        requests: z.number().int().positive(),
        period: z.enum(['day', 'month']),
      })
      .optional(),
    /** How long fetched records may be kept on disk. 0 means the current session only. */
    cacheTtlHours: z.number().nonnegative(),
    /** Whether record images may be copied into the user's tree folder. */
    mayStoreImages: z.boolean(),
    /** Credit line shown next to every result from this source. */
    attribution: z.string().min(1),
    termsUrl: z.url(),
    docsUrl: z.url(),
    /** Date (YYYY-MM-DD) these terms were last checked against the source's own pages. */
    verifiedOn: z.iso.date(),
    notes: z.array(z.string()),
  })
  .superRefine((manifest, ctx) => {
    if (manifest.tier === 'api' && !manifest.rateLimit) {
      ctx.addIssue({
        code: 'custom',
        path: ['rateLimit'],
        message: 'API connectors must declare a rate limit',
      });
    }
    if (manifest.tier === 'deeplink' && (manifest.rateLimit || manifest.quota)) {
      ctx.addIssue({
        code: 'custom',
        path: ['rateLimit'],
        message: 'deep-link sources are never fetched by the app, so limits do not apply',
      });
    }
    if ((manifest.auth === 'apiKey') !== (manifest.keyHeader !== undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['keyHeader'],
        message: 'a source with a key names the header it is sent in, and no other source does',
      });
    }
    if (manifest.auth !== 'none' && manifest.access === 'open') {
      ctx.addIssue({
        code: 'custom',
        path: ['access'],
        message: 'a source that needs credentials cannot be marked open',
      });
    }
  });

export type ConnectorManifest = z.infer<typeof connectorManifestSchema>;
export type ConnectorTier = ConnectorManifest['tier'];

/** Validates a manifest when its module loads, so a bad manifest fails at startup. */
export function defineManifest(manifest: ConnectorManifest): ConnectorManifest {
  return connectorManifestSchema.parse(manifest);
}
