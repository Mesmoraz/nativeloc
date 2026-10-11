// node:module's createRequire, only for db.ts's require('node:sqlite').
import * as sqlite from './sqlite';

export const createRequire = () => (id: string) => {
  if (id === 'node:sqlite') return sqlite;
  throw new Error(`The demo can't load ${id}.`);
};
