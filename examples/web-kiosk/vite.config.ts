import { defineConfig } from 'vite';

const api = process.env.NATIVELOC_API ?? 'http://localhost:4600';

// Same-origin proxy so the kiosk can call the NativeLoc server without CORS setup.
export default defineConfig({ server: { port: 5174, proxy: { '/api': api, '/b': api } } });
