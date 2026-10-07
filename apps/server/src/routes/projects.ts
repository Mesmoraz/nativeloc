import { createReadStream, existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { ADAPTERS, detectFormat, displayKey, type SourceEntry } from '@nativeloc/core';
import type { FastifyInstance } from 'fastify';
import { actorOf, HttpError, projectAccess, randomToken, requireUser, sha256 } from '../auth.js';
import { all, get, run, tx, type DB, type KeyRow, type ProjectRow } from '../db.js';
import { exportFile, importFile, manifest, progress, projectLocales, publish, reviewable, upsertEntries } from '../services.js';
import { checkLocale, imageSize, intParam, readMultipart } from '../util.js';

export interface ProjectDeps {
  db: DB;
  screenshotDir: string;
}

function projectJson(db: DB, p: ProjectRow) {
  return {
    id: p.id,
    name: p.name,
    sourceLocale: p.source_locale,
    locales: projectLocales(db, p.id),
    requireReview: !!p.require_review,
    peerApprovals: p.peer_approvals,
    version: p.version,
    bundleToken: p.bundle_token,
    progress: progress(db, p.id) as (ReturnType<typeof progress>[number] & { reviewable?: number })[],
  };
}

interface BoxInput {
  key: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
}

export function projectRoutes(app: FastifyInstance, { db, screenshotDir }: ProjectDeps) {
  app.get('/api/v1/formats', async () => ({
    formats: Object.values(ADAPTERS).map((a) => ({ id: a.id, label: a.label, extensions: a.extensions })),
  }));

  app.get('/api/v1/projects', async (req) => {
    const { user, locales } = requireUser(db, req);
    const rows = all<ProjectRow>(db, 'SELECT * FROM projects WHERE org_id = ? ORDER BY name', user.org_id);
    const projects = rows.map((p) => projectJson(db, p));
    // Localizers only see the languages they work on, and how much of it they can review.
    if (user.role !== 'admin') {
      projects.forEach((p, i) => {
        p.progress = p.progress.filter((r) => locales.includes(r.locale)).map((r) => ({ ...r, reviewable: reviewable(db, rows[i], r.locale, user) }));
      });
      return { projects: projects.filter((p) => p.progress.length) };
    }
    return { projects };
  });

  app.post<{ Body: { name?: string; sourceLocale?: string; locales?: string[]; requireReview?: boolean } }>('/api/v1/projects', async (req) => {
    const { user } = requireUser(db, req, ['admin']);
    const name = req.body?.name?.trim();
    if (!name) throw new HttpError(400, 'Give the project a name.');
    const source = checkLocale(req.body?.sourceLocale ?? 'en');
    const locales = [...new Set((req.body?.locales ?? []).map(checkLocale))].filter((l) => l !== source);
    const id = tx(db, () => {
      const r = run(db, 'INSERT INTO projects (org_id, name, source_locale, bundle_token, require_review) VALUES (?, ?, ?, ?, ?)', user.org_id, name, source, randomToken('pb_'), req.body?.requireReview === false ? 0 : 1);
      const pid = Number(r.lastInsertRowid);
      for (const l of locales) run(db, 'INSERT INTO project_locales (project_id, locale) VALUES (?, ?)', pid, l);
      return pid;
    });
    return { project: projectJson(db, get<ProjectRow>(db, 'SELECT * FROM projects WHERE id = ?', id)!) };
  });

  app.get<{ Params: { id: string } }>('/api/v1/projects/:id', async (req) => {
    const { project, actor } = projectAccess(db, req, intParam(req.params.id), 'read');
    const json = projectJson(db, project);
    if (actor.kind === 'user' && actor.user.role !== 'admin') json.progress = json.progress.filter((r) => actor.locales.includes(r.locale));
    return { project: json, manifest: manifest(db, project) };
  });

  app.patch<{ Params: { id: string }; Body: { name?: string; requireReview?: boolean; peerApprovals?: number; locales?: string[] } }>('/api/v1/projects/:id', async (req) => {
    const { project } = projectAccess(db, req, intParam(req.params.id), 'admin');
    tx(db, () => {
      if (req.body?.name?.trim()) run(db, 'UPDATE projects SET name = ? WHERE id = ?', req.body.name.trim(), project.id);
      if (typeof req.body?.requireReview === 'boolean') run(db, 'UPDATE projects SET require_review = ? WHERE id = ?', req.body.requireReview ? 1 : 0, project.id);
      if (req.body?.peerApprovals !== undefined) {
        const n = req.body.peerApprovals;
        if (!Number.isInteger(n) || n < 0 || n > 5) throw new HttpError(400, 'Peer approvals must be a whole number from 0 to 5.');
        run(db, 'UPDATE projects SET peer_approvals = ? WHERE id = ?', n, project.id);
      }
      if (req.body?.locales) {
        const wanted = [...new Set(req.body.locales.map(checkLocale))].filter((l) => l !== project.source_locale);
        run(db, 'DELETE FROM project_locales WHERE project_id = ?', project.id);
        for (const l of wanted) run(db, 'INSERT INTO project_locales (project_id, locale) VALUES (?, ?)', project.id, l);
      }
    });
    return { project: projectJson(db, get<ProjectRow>(db, 'SELECT * FROM projects WHERE id = ?', project.id)!) };
  });

  // ----- strings -----

  app.get<{ Params: { id: string }; Querystring: { q?: string; locale?: string; offset?: string } }>('/api/v1/projects/:id/keys', async (req) => {
    const { project } = projectAccess(db, req, intParam(req.params.id), 'read');
    const locale = req.query.locale ? checkLocale(req.query.locale) : null;
    const q = `%${req.query.q ?? ''}%`;
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const rows = all<KeyRow & { t_text: string | null; t_status: string | null; shots: number }>(
      db,
      `SELECT k.*, t.text AS t_text, t.status AS t_status,
              (SELECT COUNT(*) FROM screenshot_keys sk WHERE sk.key_id = k.id) AS shots
       FROM keys k LEFT JOIN translations t ON t.key_id = k.id AND t.locale = ?
       WHERE k.project_id = ? AND k.archived = 0 AND (k.name LIKE ? OR k.source LIKE ? OR t.text LIKE ?)
       ORDER BY k.id LIMIT 100 OFFSET ?`,
      locale ?? '', project.id, q, q, q, offset,
    );
    return {
      keys: rows.map((k) => ({
        id: k.id,
        name: k.name,
        displayName: displayKey(k.name),
        source: k.source,
        description: k.description,
        maxLength: k.max_length,
        screenshots: k.shots,
        translation: k.t_text != null ? { text: k.t_text, status: k.t_status } : null,
      })),
    };
  });

  app.patch<{ Params: { keyId: string }; Body: { description?: string | null; maxLength?: number | null } }>('/api/v1/keys/:keyId', async (req) => {
    const key = get<KeyRow>(db, 'SELECT * FROM keys WHERE id = ?', intParam(req.params.keyId));
    if (!key) throw new HttpError(404, 'String not found.');
    projectAccess(db, req, key.project_id, 'admin');
    const description = req.body?.description !== undefined ? req.body.description || null : key.description;
    const maxLength = req.body?.maxLength !== undefined ? (req.body.maxLength ? Number(req.body.maxLength) : null) : key.max_length;
    run(db, 'UPDATE keys SET description = ?, max_length = ? WHERE id = ?', description, maxLength, key.id);
    return { ok: true };
  });

  /** REST + CLI ingest: `{ entries: [{ key, source, description?, maxLength? }], locale?, prune? }`. */
  app.post<{ Params: { id: string }; Body: { entries?: SourceEntry[]; locale?: string; prune?: boolean } }>('/api/v1/projects/:id/keys', async (req) => {
    const { project, actor } = projectAccess(db, req, intParam(req.params.id), 'push');
    if (!Array.isArray(req.body?.entries)) throw new HttpError(400, 'Send { "entries": [ { "key": "...", "source": "..." } ] }.');
    const locale = req.body.locale ? checkLocale(req.body.locale) : undefined;
    return upsertEntries(db, project, req.body.entries, { locale, prune: !!req.body.prune, userId: actor.kind === 'user' ? actor.user.id : undefined });
  });

  app.post<{ Params: { id: string } }>('/api/v1/projects/:id/import', async (req) => {
    const { project, actor } = projectAccess(db, req, intParam(req.params.id), 'push');
    const { fields, file } = await readMultipart(req);
    if (!file) throw new HttpError(400, 'Attach a file.');
    const format = fields.format || detectFormat(file.filename);
    if (!format) throw new HttpError(400, 'Could not tell the file format; choose one.');
    const locale = fields.locale ? checkLocale(fields.locale) : undefined;
    return importFile(db, project, file.buffer.toString('utf8'), format, { locale, prune: fields.prune === 'true', userId: actor.kind === 'user' ? actor.user.id : undefined });
  });

  app.get<{ Params: { id: string }; Querystring: { format?: string; locale?: string } }>('/api/v1/projects/:id/export', async (req, reply) => {
    const { project } = projectAccess(db, req, intParam(req.params.id), 'export');
    const format = req.query.format ?? 'json';
    const locale = checkLocale(req.query.locale ?? project.source_locale);
    let body: string;
    try {
      body = exportFile(db, project, format, locale);
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
    const ext = format === 'android-xml' ? 'xml' : format === 'po' ? 'po' : 'json';
    reply.header('content-disposition', `attachment; filename="${locale}.${ext}"`);
    reply.type(format === 'android-xml' ? 'application/xml' : format === 'po' ? 'text/x-gettext-translation' : 'application/json');
    return body;
  });

  // ----- screenshots -----

  function saveBoxes(projectId: number, screenshotId: number, width: number, height: number, boxes: BoxInput[]) {
    const missing: string[] = [];
    for (const b of boxes) {
      const key = get<{ id: number }>(db, 'SELECT id FROM keys WHERE project_id = ? AND name = ?', projectId, b.key);
      if (!key) {
        missing.push(b.key);
        continue;
      }
      const has = [b.x, b.y, b.w, b.h].every((v) => typeof v === 'number' && Number.isFinite(v));
      // Accept pixels (from devices) or fractions (<= 1) and store fractions.
      const frac = has && [b.x, b.y, b.w, b.h].every((v) => v! <= 1);
      const fx = (v: number, size: number) => (frac ? v : v / size);
      run(
        db,
        'INSERT OR REPLACE INTO screenshot_keys (screenshot_id, key_id, x, y, w, h) VALUES (?, ?, ?, ?, ?, ?)',
        screenshotId, key.id,
        has ? fx(b.x!, width) : null, has ? fx(b.y!, height) : null, has ? fx(b.w!, width) : null, has ? fx(b.h!, height) : null,
      );
    }
    return missing;
  }

  function parseBoxes(raw: string | undefined): BoxInput[] {
    if (!raw) return [];
    try {
      const v = JSON.parse(raw);
      if (Array.isArray(v)) return v.map((b) => (typeof b === 'string' ? { key: b } : b));
    } catch {
      /* comma list */
    }
    return raw.split(',').map((k) => ({ key: k.trim() })).filter((b) => b.key);
  }

  app.post<{ Params: { id: string } }>('/api/v1/projects/:id/screenshots', async (req) => {
    const { project } = projectAccess(db, req, intParam(req.params.id), 'push');
    const { fields, file } = await readMultipart(req);
    if (!file) throw new HttpError(400, 'Attach a PNG or JPEG screenshot.');
    const size = imageSize(file.buffer);
    if (!size) throw new HttpError(415, 'Screenshots must be PNG or JPEG.');
    const name = `${project.id}-${randomToken().slice(0, 16)}.${size.ext}`;
    writeFileSync(join(screenshotDir, name), file.buffer);
    const r = run(db, 'INSERT INTO screenshots (project_id, file, label, width, height) VALUES (?, ?, ?, ?, ?)', project.id, name, fields.label || file.filename, size.width, size.height);
    const id = Number(r.lastInsertRowid);
    const missingKeys = saveBoxes(project.id, id, size.width, size.height, parseBoxes(fields.keys));
    return { id, width: size.width, height: size.height, missingKeys };
  });

  app.get<{ Params: { id: string } }>('/api/v1/projects/:id/screenshots', async (req) => {
    const { project } = projectAccess(db, req, intParam(req.params.id), 'read');
    const shots = all<{ id: number; file: string; label: string; width: number; height: number; created_at: string }>(db, 'SELECT * FROM screenshots WHERE project_id = ? ORDER BY id DESC', project.id);
    return {
      screenshots: shots.map((s) => ({
        id: s.id,
        url: `/files/screenshots/${s.file}`,
        label: s.label,
        width: s.width,
        height: s.height,
        keys: all<{ key: string; x: number | null; y: number | null; w: number | null; h: number | null }>(
          db,
          'SELECT k.name AS key, sk.x, sk.y, sk.w, sk.h FROM screenshot_keys sk JOIN keys k ON k.id = sk.key_id WHERE sk.screenshot_id = ?',
          s.id,
        ),
      })),
    };
  });

  app.put<{ Params: { sid: string }; Body: { keys?: BoxInput[] } }>('/api/v1/screenshots/:sid/keys', async (req) => {
    const shot = get<{ id: number; project_id: number; width: number; height: number }>(db, 'SELECT * FROM screenshots WHERE id = ?', intParam(req.params.sid));
    if (!shot) throw new HttpError(404, 'Screenshot not found.');
    projectAccess(db, req, shot.project_id, 'admin');
    const missingKeys = tx(db, () => {
      run(db, 'DELETE FROM screenshot_keys WHERE screenshot_id = ?', shot.id);
      return saveBoxes(shot.project_id, shot.id, shot.width, shot.height, req.body?.keys ?? []);
    });
    return { missingKeys };
  });

  app.delete<{ Params: { sid: string } }>('/api/v1/screenshots/:sid', async (req) => {
    const shot = get<{ id: number; project_id: number; file: string }>(db, 'SELECT * FROM screenshots WHERE id = ?', intParam(req.params.sid));
    if (!shot) throw new HttpError(404, 'Screenshot not found.');
    projectAccess(db, req, shot.project_id, 'admin');
    run(db, 'DELETE FROM screenshots WHERE id = ?', shot.id);
    const path = join(screenshotDir, shot.file);
    if (existsSync(path)) unlinkSync(path);
    return { ok: true };
  });

  app.get<{ Params: { file: string } }>('/files/screenshots/:file', async (req, reply) => {
    const file = basename(req.params.file);
    const shot = get<{ project_id: number }>(db, 'SELECT project_id FROM screenshots WHERE file = ?', file);
    if (!shot) throw new HttpError(404, 'Not found.');
    projectAccess(db, req, shot.project_id, 'read');
    reply.type(file.endsWith('.png') ? 'image/png' : 'image/jpeg').header('cache-control', 'private, max-age=86400');
    return reply.send(createReadStream(join(screenshotDir, file)));
  });

  // ----- publishing -----

  app.post<{ Params: { id: string } }>('/api/v1/projects/:id/publish', async (req) => {
    const id = intParam(req.params.id);
    const actor = actorOf(db, req);
    const { project } = projectAccess(db, req, id, actor?.kind === 'token' ? 'push' : 'admin');
    return { manifest: publish(db, project) };
  });

  app.post<{ Params: { id: string } }>('/api/v1/projects/:id/rotate-bundle-token', async (req) => {
    const { project } = projectAccess(db, req, intParam(req.params.id), 'admin');
    const token = randomToken('pb_');
    run(db, 'UPDATE projects SET bundle_token = ? WHERE id = ?', token, project.id);
    return { bundleToken: token };
  });

  // ----- API tokens -----

  app.get<{ Params: { id: string } }>('/api/v1/projects/:id/tokens', async (req) => {
    const { project } = projectAccess(db, req, intParam(req.params.id), 'admin');
    return {
      tokens: all<{ id: number; name: string; scopes: string; created_at: string; last_used_at: string | null }>(db, 'SELECT id, name, scopes, created_at, last_used_at FROM api_tokens WHERE project_id = ? ORDER BY id', project.id).map((t) => ({
        ...t,
        scopes: JSON.parse(t.scopes),
      })),
    };
  });

  app.post<{ Params: { id: string }; Body: { name?: string; scopes?: string[] } }>('/api/v1/projects/:id/tokens', async (req) => {
    const { project } = projectAccess(db, req, intParam(req.params.id), 'admin');
    const scopes = (req.body?.scopes ?? ['push']).filter((s) => s === 'push' || s === 'read');
    if (!scopes.length) throw new HttpError(400, 'Pick at least one scope: push or read.');
    const token = randomToken('nl_');
    run(db, 'INSERT INTO api_tokens (project_id, name, token_hash, scopes) VALUES (?, ?, ?, ?)', project.id, req.body?.name?.trim() || 'token', sha256(token), JSON.stringify(scopes));
    return { token, scopes };
  });

  app.delete<{ Params: { id: string; tokenId: string } }>('/api/v1/projects/:id/tokens/:tokenId', async (req) => {
    const { project } = projectAccess(db, req, intParam(req.params.id), 'admin');
    run(db, 'DELETE FROM api_tokens WHERE id = ? AND project_id = ?', intParam(req.params.tokenId), project.id);
    return { ok: true };
  });
}
