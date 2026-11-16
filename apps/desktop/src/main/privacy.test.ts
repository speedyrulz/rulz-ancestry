import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CENSUS_HOST, OA_CATALOGUE_URL, OA_CSV_HOST, manifests } from '@rulz/connectors';
import { describe, expect, it } from 'vitest';
import { API_BASE_URL } from './aiapi';
import { GEONAMES_BASE_URL } from './gazetteer';
import { FEED, RELEASE_DOWNLOAD_HOST, RELEASE_FILE_HOST } from './updates';

/**
 * The privacy statement names every host the app can contact. The hosts are collected from the
 * code (the manifests of the connectors and the fixed addresses of the app), so a source added
 * to the registry, or an address changed, fails here until docs/PRIVACY.md names it. Hosts that
 * are written inline in other code (not in a manifest or a constant exported here) are not seen.
 */

const STATEMENT = readFileSync(resolve(import.meta.dirname, '../../../../docs/PRIVACY.md'), 'utf8');

/** The host of an address, or of a bare host name. */
function hostOf(address: string): string {
  return address.includes('://') ? new URL(address).hostname : address;
}

/** Every host of the fixed addresses, with where it comes from. */
function fixedHosts(): Map<string, string> {
  const hosts = new Map<string, string>();
  const add = (host: string, from: string) => {
    if (!hosts.has(host)) hosts.set(host, from);
  };
  add(hostOf(FEED), 'the update feed');
  add(RELEASE_DOWNLOAD_HOST, 'the release page and the installer the update downloads');
  add(RELEASE_FILE_HOST, 'the release files the update downloads');
  add(hostOf(GEONAMES_BASE_URL), 'the place list');
  add(hostOf(API_BASE_URL), 'the AI assistant, route C');
  add(CENSUS_HOST, 'the 1950 census packs');
  add(OA_CSV_HOST, 'the Open Archives packs');
  add(hostOf(OA_CATALOGUE_URL), 'the Open Archives catalogue');
  return hosts;
}

/** Every host a connector's manifest names as its API or its site. */
function connectorHosts(): Map<string, string> {
  const hosts = new Map<string, string>();
  for (const manifest of manifests) {
    for (const address of [manifest.baseUrl, manifest.siteUrl]) {
      if (address === undefined) continue;
      const host = hostOf(address);
      if (!hosts.has(host)) hosts.set(host, `the connector ${manifest.id}`);
    }
  }
  return hosts;
}

/**
 * Every host a manifest links to for the user to open in a browser (where to get a key, the terms,
 * the docs). The app asks nothing of them; the statement lists them so that it names every address.
 */
function linkHosts(): Map<string, string> {
  const hosts = new Map<string, string>();
  for (const manifest of manifests) {
    for (const [field, value] of Object.entries(manifest)) {
      if (field === 'baseUrl' || field === 'siteUrl') continue;
      if (typeof value !== 'string' || !/^https?:\/\//.test(value)) continue;
      const host = hostOf(value);
      if (!hosts.has(host)) hosts.set(host, `${field} of the connector ${manifest.id}`);
    }
  }
  return hosts;
}

/** The hosts the statement names, each written between backticks. */
function namedHosts(): Set<string> {
  return new Set([...STATEMENT.matchAll(/`([a-z0-9][a-z0-9.-]*)`/g)].map((match) => match[1]!));
}

describe('the privacy statement', () => {
  const named = namedHosts();

  it('finds the hosts to check', () => {
    // A change that made the collection come up empty would pass every other test here.
    expect(connectorHosts().size).toBeGreaterThanOrEqual(15);
    expect(fixedHosts().size).toBeGreaterThanOrEqual(6);
  });

  it.each([...connectorHosts()])('names the host %s of a connector (%s)', (host) => {
    expect(named, `docs/PRIVACY.md does not name ${host}`).toContain(host);
  });

  it.each([...linkHosts()])('names the link-only host %s (%s)', (host) => {
    expect(named, `docs/PRIVACY.md does not name ${host}`).toContain(host);
  });

  it.each([...fixedHosts()])('names the host %s of the app (%s)', (host) => {
    expect(named, `docs/PRIVACY.md does not name ${host}`).toContain(host);
  });
});
