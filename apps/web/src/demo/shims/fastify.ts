import { Buffer } from 'buffer';

// A browser stand-in for the parts of Fastify the NativeLoc server uses, so the demo can run the real routes
// in the page. Only routing, params, query, JSON bodies, cookies, multipart and the reply helpers are here.

type Handler = (req: DemoRequest, reply: DemoReply) => unknown;
type ErrorHandler = (err: Error, req: DemoRequest, reply: DemoReply) => unknown;

interface Route {
  method: string;
  parts: string[];
  handler: Handler;
  statics: number;
}

export interface DemoRequestInit {
  method: string;
  url: string;
  body?: unknown;
  form?: FormData;
  headers?: Record<string, string>;
  cookies?: Record<string, string>;
}

export interface DemoResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  cookies: { name: string; value: string | null }[];
}

class DemoRequest {
  params: Record<string, string> = {};
  query: Record<string, string | string[]> = {};
  body: unknown;
  headers: Record<string, string>;
  cookies: Record<string, string>;
  method: string;
  url: string;
  protocol = location.protocol.replace(':', '');
  host = location.host;
  hostname = location.hostname;
  private form?: FormData;

  constructor(init: DemoRequestInit) {
    this.method = init.method.toUpperCase();
    this.url = init.url;
    this.body = init.body;
    this.form = init.form;
    this.headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    this.cookies = init.cookies ?? {};
    const qs = init.url.includes('?') ? init.url.slice(init.url.indexOf('?') + 1) : '';
    for (const [k, v] of new URLSearchParams(qs)) {
      const prev = this.query[k];
      this.query[k] = prev === undefined ? v : Array.isArray(prev) ? [...prev, v] : [prev, v];
    }
  }

  isMultipart() {
    return !!this.form;
  }

  async *parts() {
    for (const [fieldname, value] of this.form ?? []) {
      if (typeof value === 'string') yield { type: 'field', fieldname, value };
      else {
        const bytes = new Uint8Array(await value.arrayBuffer());
        yield { type: 'file', fieldname, filename: value.name, mimetype: value.type, toBuffer: async () => Buffer.from(bytes) };
      }
    }
  }

  on() {}
  destroy() {}
}

class DemoReply {
  statusCode = 200;
  headers: Record<string, string> = {};
  payload: unknown;
  sent = false;
  cookies: { name: string; value: string | null }[] = [];

  code(n: number) {
    this.statusCode = n;
    return this;
  }
  status(n: number) {
    return this.code(n);
  }
  header(k: string, v: string | number) {
    this.headers[k.toLowerCase()] = String(v);
    return this;
  }
  type(t: string) {
    return this.header('content-type', t);
  }
  send(payload?: unknown) {
    this.payload = payload;
    this.sent = true;
    return this;
  }
  redirect(url: string, code = 302) {
    this.statusCode = typeof url === 'number' ? url : code;
    this.headers.location = typeof url === 'number' ? String(code) : url;
    return this.send();
  }
  setCookie(name: string, value: string) {
    this.cookies.push({ name, value });
    return this;
  }
  clearCookie(name: string) {
    this.cookies.push({ name, value: null });
    return this;
  }
  sendFile() {
    return this.code(404).send({ error: 'Not found.' });
  }
}

const split = (path: string) => path.split('?')[0].split('/').slice(1);

class DemoApp {
  private routes: Route[] = [];
  private errorHandler: ErrorHandler = (err, _req, reply) => reply.code(500).send({ error: err.message });
  log = { error: console.error, warn: console.warn, info: () => {}, debug: () => {} };
  [key: string]: unknown;

  private add(method: string, path: string, a: unknown, b?: unknown) {
    const handler = (typeof a === 'function' ? a : b) as Handler;
    const parts = split(path);
    this.routes.push({ method, parts, handler, statics: parts.filter((p) => !p.startsWith(':') && p !== '*').length });
  }
  get(path: string, a: unknown, b?: unknown) {
    this.add('GET', path, a, b);
    this.add('HEAD', path, a, b);
  }
  post(path: string, a: unknown, b?: unknown) {
    this.add('POST', path, a, b);
  }
  put(path: string, a: unknown, b?: unknown) {
    this.add('PUT', path, a, b);
  }
  patch(path: string, a: unknown, b?: unknown) {
    this.add('PATCH', path, a, b);
  }
  delete(path: string, a: unknown, b?: unknown) {
    this.add('DELETE', path, a, b);
  }
  async register() {}
  addHook() {}
  setNotFoundHandler() {}
  setErrorHandler(fn: ErrorHandler) {
    this.errorHandler = fn;
  }
  decorate(name: string, value: unknown) {
    this[name] = value;
  }
  async close() {}

  private match(method: string, url: string) {
    const segs = split(url).map(decodeURIComponent);
    let best: { route: Route; params: Record<string, string> } | null = null;
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < route.parts.length; i++) {
        const p = route.parts[i];
        if (p === '*') {
          params['*'] = segs.slice(i).join('/');
          break;
        }
        if (i >= segs.length) ok = false;
        else if (p.startsWith(':')) params[p.slice(1)] = segs[i];
        else if (p !== segs[i]) ok = false;
        if (!ok) break;
        if (i === route.parts.length - 1 && segs.length !== route.parts.length) ok = false;
      }
      if (ok && (!best || route.statics > best.route.statics)) best = { route, params };
    }
    return best;
  }

  /** Handle one request the way Fastify's inject would. */
  async handle(init: DemoRequestInit): Promise<DemoResponse> {
    const req = new DemoRequest(init);
    const reply = new DemoReply();
    const found = this.match(req.method, req.url);
    if (!found) {
      reply.code(404).send({ error: 'Not found.' });
    } else {
      req.params = found.params;
      try {
        const out = await found.route.handler(req, reply);
        if (!reply.sent && out !== reply) reply.send(out);
      } catch (err) {
        reply.statusCode = 200;
        await this.errorHandler(err as Error, req, reply);
      }
    }
    return { status: reply.statusCode, headers: reply.headers, body: reply.payload, cookies: reply.cookies };
  }
}

export type FastifyInstance = DemoApp;
export type FastifyRequest = DemoRequest;
export type FastifyReply = DemoReply;
export default function Fastify(_opts?: unknown) {
  return new DemoApp();
}
