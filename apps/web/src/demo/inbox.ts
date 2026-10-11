// The online demo's inbox: emails the in-browser server sends (like the sign-up confirmation) land here and
// show in the demo banner. No dependencies, so the banner can use it without loading the server.
export interface DemoEmail {
  to: string;
  subject: string;
  body: string;
  at: string;
}

const KEY = 'nl-demo-inbox';
export const INBOX_EVENT = 'nl-demo-inbox';
/** Used when storage is blocked (some private windows). */
let memory: DemoEmail[] = [];

export function readInbox(): DemoEmail[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '[]');
  } catch {
    return memory;
  }
}

function write(inbox: DemoEmail[]) {
  memory = inbox;
  try {
    if (inbox.length) localStorage.setItem(KEY, JSON.stringify(inbox));
    else localStorage.removeItem(KEY);
  } catch {
    /* private window: the inbox lasts until reload */
  }
  window.dispatchEvent(new CustomEvent(INBOX_EVENT));
}

export function deliver(msg: { to: string; subject: string; body: string }) {
  write([{ ...msg, at: new Date().toISOString() }, ...readInbox()].slice(0, 20));
}

export const clearInbox = () => write([]);
