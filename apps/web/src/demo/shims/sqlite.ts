// node:sqlite's DatabaseSync, on top of sql.js. The demo loads sql.js and the seeded database bytes first
// (see demo/runtime.ts), then the server's openDb() opens them through this class.
import type { Database, SqlJsStatic, SqlValue } from 'sql.js';

type Param = SqlValue | boolean | bigint | undefined;

declare global {
  // eslint-disable-next-line no-var
  var __demoSql: { SQL: SqlJsStatic; bytes: Uint8Array | null; db?: Database } | undefined;
}

const toSql = (p: Param): SqlValue => (p === undefined ? null : typeof p === 'boolean' ? Number(p) : typeof p === 'bigint' ? Number(p) : p);

class Statement {
  constructor(
    private db: Database,
    private sql: string,
  ) {}

  private withStmt<T>(params: Param[], fn: (s: ReturnType<Database['prepare']>) => T): T {
    const stmt = this.db.prepare(this.sql);
    try {
      if (params.length) stmt.bind(params.map(toSql));
      return fn(stmt);
    } finally {
      stmt.free();
    }
  }

  all(...params: Param[]) {
    return this.withStmt(params, (s) => {
      const rows: Record<string, SqlValue>[] = [];
      while (s.step()) rows.push(s.getAsObject());
      return rows;
    });
  }

  get(...params: Param[]) {
    return this.withStmt(params, (s) => (s.step() ? s.getAsObject() : undefined));
  }

  run(...params: Param[]) {
    this.withStmt(params, (s) => {
      while (s.step());
    });
    const id = this.db.exec('SELECT last_insert_rowid()')[0]?.values[0][0] ?? 0;
    return { changes: this.db.getRowsModified(), lastInsertRowid: id as number };
  }
}

export class DatabaseSync {
  private db: Database;

  constructor(_path: string) {
    const g = globalThis.__demoSql;
    if (!g) throw new Error('sql.js is not loaded yet.');
    this.db = new g.SQL.Database(g.bytes ?? undefined);
    g.db = this.db;
  }

  exec(sql: string) {
    // WAL needs a real file; sql.js keeps the database in memory.
    this.db.exec(sql.replace(/PRAGMA journal_mode\s*=\s*WAL;?/gi, ''));
  }

  prepare(sql: string) {
    return new Statement(this.db, sql);
  }

  close() {}
}
