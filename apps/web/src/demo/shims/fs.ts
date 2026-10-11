// A tiny in-memory node:fs for the demo: uploaded screenshots live here until the page reloads.
const files = new Map<string, Uint8Array>();

export const existsSync = (p: string) => files.has(p);
export const mkdirSync = () => undefined;
export const writeFileSync = (p: string, data: Uint8Array | string) => {
  files.set(p, typeof data === 'string' ? new TextEncoder().encode(data) : data);
};
export const readFileSync = (p: string) => {
  const f = files.get(p);
  if (!f) throw new Error(`ENOENT: ${p}`);
  return f;
};
export const unlinkSync = (p: string) => {
  files.delete(p);
};
export const rmSync = unlinkSync;
export const createReadStream = (p: string) => readFileSync(p);
export default { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync, rmSync, createReadStream };
