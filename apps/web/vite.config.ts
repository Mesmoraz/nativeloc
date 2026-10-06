import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const api = process.env.NATIVELOC_API ?? 'http://localhost:4600';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': api, '/b': api, '/files': api },
  },
});
