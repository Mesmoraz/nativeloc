import type { Adapter, ExportEntry, SourceEntry } from './types.js';

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

function walk(node: Json, prefix: string, out: SourceEntry[]) {
  if (typeof node === 'string') {
    out.push({ key: prefix, source: node });
    return;
  }
  if (!node || typeof node !== 'object' || Array.isArray(node)) return;
  // Chrome/WebExtension style: { "key": { "message": "...", "description": "..." } }
  if (typeof node.message === 'string') {
    out.push({
      key: prefix,
      source: node.message,
      ...(typeof node.description === 'string' ? { description: node.description } : {}),
      ...(typeof node.maxLength === 'number' ? { maxLength: node.maxLength } : {}),
    });
    return;
  }
  for (const [k, v] of Object.entries(node)) walk(v, prefix ? `${prefix}.${k}` : k, out);
}

function parse(content: string) {
  const entries: SourceEntry[] = [];
  walk(JSON.parse(content.replace(/^﻿/, '')) as Json, '', entries);
  return { entries };
}

function translated(entries: ExportEntry[]) {
  return entries.filter((e): e is ExportEntry & { text: string } => e.text != null);
}

export const jsonAdapter: Adapter = {
  id: 'json',
  label: 'JSON (flat keys)',
  extensions: ['.json'],
  parse,
  serialize: (entries) => JSON.stringify(Object.fromEntries(translated(entries).map((e) => [e.key, e.text])), null, 2) + '\n',
};

export const jsonNestedAdapter: Adapter = {
  id: 'json-nested',
  label: 'JSON (nested by dots)',
  extensions: ['.json'],
  parse,
  serialize(entries) {
    const root: Record<string, unknown> = {};
    for (const e of translated(entries)) {
      const parts = e.key.split('.');
      let node = root;
      for (const p of parts.slice(0, -1)) {
        if (typeof node[p] !== 'object' || node[p] === null) node[p] = {};
        node = node[p] as Record<string, unknown>;
      }
      node[parts[parts.length - 1]] = e.text;
    }
    return JSON.stringify(root, null, 2) + '\n';
  },
};
