import type { FastifyRequest } from 'fastify';
import { HttpError } from './auth.js';

export interface Upload {
  filename: string;
  mimetype: string;
  buffer: Buffer;
}

/** Collect a multipart request into plain fields plus the first file. */
export async function readMultipart(req: FastifyRequest): Promise<{ fields: Record<string, string>; file?: Upload }> {
  if (!req.isMultipart()) throw new HttpError(400, 'Expected a multipart/form-data upload.');
  const fields: Record<string, string> = {};
  let file: Upload | undefined;
  for await (const part of req.parts()) {
    if (part.type === 'file') {
      const buffer = await part.toBuffer();
      file ??= { filename: part.filename, mimetype: part.mimetype, buffer };
    } else {
      fields[part.fieldname] = String(part.value);
    }
  }
  return { fields, file };
}

/** Width/height of a PNG or JPEG without decoding it. */
export function imageSize(buf: Buffer): { width: number; height: number; ext: 'png' | 'jpg' } | null {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), ext: 'png' };
  }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = buf[i + 1];
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7), ext: 'jpg' };
      }
      i += 2 + len;
    }
  }
  return null;
}

export const intParam = (v: unknown, name = 'id'): number => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, `Invalid ${name}.`);
  return n;
};

const LOCALE_RE = /^[a-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*$/;
export function checkLocale(locale: unknown): string {
  if (typeof locale !== 'string' || !LOCALE_RE.test(locale)) throw new HttpError(400, `"${String(locale)}" is not a valid language code (e.g. es, fr-CA, zh-Hans).`);
  return locale.replace('_', '-');
}
