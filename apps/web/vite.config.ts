import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const api = process.env.NATIVELOC_API ?? 'http://localhost:4600';
const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/**
 * `vite build --mode demo` is the online demo (GitHub Pages): the server runs in the page, on sql.js, through
 * the stand-ins in src/demo/shims. DEMO_BASE is the path it's served under (default /nativeloc/).
 */
export default defineConfig(({ mode }) => {
  const demo = mode === 'demo';
  const shim = (name: string) => here(`./src/demo/shims/${name}.ts`);
  return {
    plugins: [react()],
    base: demo ? (process.env.DEMO_BASE ?? '/nativeloc/') : '/',
    // The server reads settings from process.env; in the demo that's what runtime.ts puts on globalThis.process.
    define: demo ? { 'import.meta.env.VITE_DEMO': '"1"', 'process.env': 'globalThis.process.env' } : {},
    resolve: demo
      ? {
          alias: [
            { find: /^demo-server$/, replacement: here('../server/src/app.ts') },
            { find: /^demo-server-mailer$/, replacement: here('../server/src/signup/mailer.ts') },
            { find: 'fastify', replacement: shim('fastify') },
            { find: /^@fastify\/(cookie|multipart|static)$/, replacement: shim('plugin') },
            { find: 'node:sqlite', replacement: shim('sqlite') },
            { find: 'node:crypto', replacement: shim('crypto') },
            { find: 'node:fs', replacement: shim('fs') },
            { find: 'node:module', replacement: shim('module') },
            { find: 'node:path', replacement: 'path-browserify' },
            { find: /^node:(dns|dns\/promises|net|http|https|readline)$/, replacement: shim('offline') },
          ],
        }
      : { alias: { 'demo-server': shim('no-demo-server'), 'demo-server-mailer': shim('no-demo-server') } },
    build: demo ? { target: 'es2022', rollupOptions: { input: { main: here('./index.html'), preview: here('./preview.html') } } } : {},
    server: {
      port: 5173,
      proxy: { '/api': api, '/b': api, '/files': api, '/preview/': api },
    },
  };
});
