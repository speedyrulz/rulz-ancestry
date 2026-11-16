import { getSetting, setSetting, type Db } from '@rulz/db';
import { z } from 'zod';
import type { UpdateMethod, UpdateResult, UpdateState } from '../shared/updates';
import type { HandlerTable } from './handlers';

export type UpdateHandlers = Pick<HandlerTable, UpdateMethod>;
export const FEED =
  'https://github.com/speedyrulz/rulz-kinspora/releases/latest/download/latest.yml';
const SETTING = 'update.startup';
const DISMISSED = 'update.dismissed';
const semver =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function compareVersions(a: string, b: string): number | null {
  const x = semver.exec(a),
    y = semver.exec(b);
  if (!x || !y) return null;
  for (let i = 1; i <= 3; i++) {
    const n = BigInt(x[i]!),
      m = BigInt(y[i]!);
    if (n !== m) return n > m ? 1 : -1;
  }
  if (!x[4] || !y[4]) return x[4] === y[4] ? 0 : x[4] ? -1 : 1;
  const xs = x[4].split('.'),
    ys = y[4].split('.');
  for (let i = 0; i < Math.max(xs.length, ys.length); i++) {
    const p = xs[i],
      q = ys[i];
    if (p === undefined || q === undefined) return p === undefined ? -1 : 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p),
      qn = /^\d+$/.test(q);
    if (pn && qn) return BigInt(p) > BigInt(q) ? 1 : -1;
    if (pn !== qn) return pn ? -1 : 1;
    return p > q ? 1 : -1;
  }
  return 0;
}

interface Options {
  db: Db;
  version: string;
  packaged: boolean;
  feed?: string;
  busy: () => boolean;
  fetch: typeof fetch;
  open: (url: string) => Promise<unknown>;
  timeoutMs?: number;
  clock?: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout };
}
export class UpdateService {
  private available: string | null = null;
  private checking = false;
  private stopped = false;
  private controller: AbortController | undefined;
  constructor(private readonly options: Options) {}
  state(): UpdateState {
    return { startup: getSetting(this.options.db, SETTING) !== 'off', version: this.available };
  }
  setStartup(enabled: boolean): void {
    setSetting(this.options.db, SETTING, enabled ? 'on' : 'off');
  }
  dismiss(): void {
    if (this.available) setSetting(this.options.db, DISMISSED, this.available);
    this.available = null;
  }
  async open(): Promise<void> {
    if (this.available && semver.test(this.available))
      await this.options.open(
        `https://github.com/speedyrulz/rulz-kinspora/releases/tag/v${this.available}`,
      );
  }
  stop(): void {
    this.stopped = true;
    this.controller?.abort();
  }
  async check(userStarted = false): Promise<UpdateResult> {
    if (this.stopped) return 'failed';
    if (this.checking || this.options.busy()) return 'busy';
    this.checking = true;
    const controller = new AbortController();
    this.controller = controller;
    const clock = this.options.clock ?? { setTimeout, clearTimeout };
    const timer = clock.setTimeout(() => controller.abort(), this.options.timeoutMs ?? 15_000);
    try {
      let url = new URL(this.options.packaged ? FEED : this.options.feed || FEED);
      const allowed = (u: URL, initial: boolean) =>
        u.protocol === 'https:' ||
        (!this.options.packaged && initial && u.protocol === 'http:' && u.hostname === '127.0.0.1');
      if (!allowed(url, true)) throw new Error('Invalid feed');
      let response: Response | undefined;
      for (let redirects = 0; redirects <= 3; redirects++) {
        response = await this.options.fetch(url.toString(), {
          redirect: 'manual',
          signal: controller.signal,
        });
        if (response.status < 300 || response.status >= 400) break;
        const location = response.headers.get('location');
        if (!location || redirects === 3) throw new Error('Invalid redirect');
        url = new URL(location, url);
        if (!allowed(url, false)) throw new Error('Invalid redirect');
      }
      if (!response?.ok || !response.body) throw new Error('Feed unavailable');
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.length;
        if (size > 65_536) {
          await reader.cancel();
          throw new Error('Feed too large');
        }
        chunks.push(part.value);
      }
      const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
      const lines = [...text.matchAll(/^version:\s*([^\s]+)\s*$/gm)];
      if (lines.length !== 1) throw new Error('Invalid feed');
      const version = lines[0]![1]!;
      const comparison = compareVersions(version, this.options.version);
      if (comparison === null) {
        this.available = null;
        throw new Error('Invalid version');
      }
      if (this.stopped) return 'failed';
      if (comparison <= 0) {
        this.available = null;
        return 'current';
      }
      const dismissed = getSetting(this.options.db, DISMISSED);
      this.available =
        !userStarted && dismissed && (compareVersions(version, dismissed) ?? 1) <= 0
          ? null
          : version;
      return 'newer';
    } catch {
      return 'failed';
    } finally {
      clock.clearTimeout(timer);
      this.controller = undefined;
      this.checking = false;
    }
  }
}

/** Schedule a startup check, retrying busy checks for up to 30 minutes. */
export function scheduleStartupUpdate(service: UpdateService): () => void {
  let stopped = false;
  let attempts = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = async () => {
    if (stopped) return;
    try {
      if (!service.state().startup) return;
      const result = await service.check();
      if (!stopped && result === 'busy' && ++attempts <= 30) {
        timer = setTimeout(() => void run(), 60_000);
      }
    } catch {
      // Startup checks fail silently, including when the app is closing.
    }
  };
  timer = setTimeout(() => void run(), 5000);
  return () => {
    stopped = true;
    clearTimeout(timer);
    service.stop();
  };
}

export function createUpdateHandlers(service: UpdateService): UpdateHandlers {
  return {
    updateState: (...args) => {
      z.tuple([]).parse(args);
      return service.state();
    },
    checkUpdate: (...args) => {
      z.tuple([]).parse(args);
      return service.check(true);
    },
    setUpdateStartup: (...args) => {
      const [enabled] = z.tuple([z.boolean()]).parse(args);
      service.setStartup(enabled);
    },
    dismissUpdate: (...args) => {
      z.tuple([]).parse(args);
      service.dismiss();
    },
    openUpdate: (...args) => {
      z.tuple([]).parse(args);
      return service.open();
    },
  };
}
