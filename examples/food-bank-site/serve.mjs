// A pretend nonprofit website for the hosted-preview demo. Serves this folder at http://localhost:5175
// with clean addresses (/get-food → get-food.html), like a typical small-organization site.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const port = Number(process.env.PORT ?? 5175);
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.svg': 'image/svg+xml' };

createServer(async (req, res) => {
  const path = new URL(req.url ?? '/', 'http://x').pathname;
  const name = path === '/' ? 'index.html' : extname(path) ? path.slice(1) : `${path.slice(1)}.html`;
  if (name.includes('..') || name.endsWith('.mjs')) return res.writeHead(404).end();
  try {
    const body = await readFile(join(root, name));
    res.writeHead(200, { 'content-type': types[extname(name)] ?? 'application/octet-stream' }).end(body);
  } catch {
    res.writeHead(404, { 'content-type': types['.html'] }).end('<!doctype html><title>Not found</title><p>Page not found.</p>');
  }
}).listen(port, () => console.log(`Demo food bank site: http://localhost:${port}`));
