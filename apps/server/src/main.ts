import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { buildApp } from './app.js';

const root = resolve(fileURLToPath(import.meta.url), '../../../..');
const dataDir = resolve(process.env.NATIVELOC_DATA ?? resolve(root, 'data'));
const port = Number(process.env.PORT ?? 4600);

const { app } = await buildApp({
  dbPath: resolve(dataDir, 'nativeloc.sqlite'),
  dataDir,
  webDist: resolve(root, 'apps/web/dist'),
  logger: process.env.NODE_ENV !== 'test',
});

await app.listen({ port, host: process.env.HOST ?? '0.0.0.0' });
