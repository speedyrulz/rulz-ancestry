import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import type { Plugin } from 'vite';

/**
 * Fills in the Content-Security-Policy meta tag in index.html.
 *
 * The packaged app allows only its own bundled scripts. The dev server needs
 * two relaxations: Vite's React refresh preamble is an inline script, and hot
 * reload talks to the dev server over a WebSocket.
 */
function contentSecurityPolicy(): Plugin {
  return {
    name: 'rulz-content-security-policy',
    transformIndexHtml: {
      order: 'pre',
      handler(html, ctx) {
        const dev = ctx.server !== undefined;
        const policy = [
          "default-src 'self'",
          dev ? "script-src 'self' 'unsafe-inline'" : "script-src 'self'",
          // Inline style attributes are needed by React and by chart libraries.
          "style-src 'self' 'unsafe-inline'",
          // The pictures of the open tree come from the app's own media scheme
          // (see MEDIA_SCHEME in src/shared/ipc.ts).
          "img-src 'self' data: blob: rulz-media:",
          "font-src 'self'",
          dev ? "connect-src 'self' ws://localhost:* ws://127.0.0.1:*" : "connect-src 'self'",
          "object-src 'none'",
          "base-uri 'none'",
          "form-action 'none'",
        ].join('; ');
        return html.replace('__CSP__', policy);
      },
    },
  };
}

export default defineConfig({
  // Workspace packages (@rulz/*) are devDependencies, so they are bundled into
  // the main process. Only package.json "dependencies" stay external, which is
  // what the native better-sqlite3 module needs.
  main: {},
  preload: {
    build: {
      // A sandboxed preload script must be one self-contained CommonJS file.
      externalizeDeps: false,
      rolldownOptions: {
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    plugins: [react(), contentSecurityPolicy()],
  },
});
