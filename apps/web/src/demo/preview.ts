// The online demo's website preview. The real server serves /preview/{token}/... itself; on GitHub Pages
// the address is preview.html#/preview/{token}/..., and this page asks the in-browser server for it.
import { demoFetch } from './runtime';

const BASE = import.meta.env.BASE_URL;
const SITE = 'http://localhost:5175';

/** Point the page's links at this demo: preview pages stay in preview.html, the original site is published alongside. */
function relink(html: string, path: string) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  for (const a of doc.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    const href = a.getAttribute('href')!;
    const fromPreview = href.startsWith(`${BASE}preview.html#`) ? href.slice(`${BASE}preview.html#`.length) : null;
    const url = new URL(fromPreview ?? href, `http://preview.invalid${path}`);
    if (url.origin === 'http://preview.invalid' && url.pathname.startsWith('/preview/')) a.href = `${location.origin}${BASE}preview.html#${url.pathname}`;
    else if (url.origin === SITE) {
      const page = url.pathname === '/' ? 'index.html' : /\.[a-z]+$/.test(url.pathname) ? url.pathname.slice(1) : `${url.pathname.slice(1)}.html`;
      a.href = `${location.origin}${BASE}food-bank-site/${page}`;
    }
  }
  // A sandboxed frame can't reliably navigate this window, so link clicks are passed up (see the listener below).
  const relay = doc.createElement('script');
  relay.textContent = `document.addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('a[href]');
    if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault();
    parent.postMessage({ nativelocPreviewLink: a.href }, '*');
  });`;
  doc.head.prepend(relay);
  return `<!doctype html>${doc.documentElement.outerHTML}`;
}

// Same limits the server's Content-Security-Policy sandbox sets.
const SANDBOX = 'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation';

async function show() {
  const status = document.getElementById('status')!;
  let path = location.hash.slice(1) || '/preview/';
  for (let hops = 0; hops < 5; hops++) {
    const res = await demoFetch(path);
    const to = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && to) {
      if (!to.startsWith('/preview/')) return void (location.href = to);
      path = to;
      history.replaceState(null, '', `#${path}`);
      continue;
    }
    const html = await res.text();
    if (!res.ok || !/html/.test(res.headers.get('content-type') ?? '')) {
      status.textContent = res.status === 404 ? 'This preview link is not valid.' : 'Could not show this page.';
      return;
    }
    status.remove();
    document.querySelector('iframe')?.remove();
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', SANDBOX);
    frame.srcdoc = relink(html, path);
    document.body.append(frame);
    document.title = /<title>([^<]*)<\/title>/i.exec(html)?.[1] ?? 'Website preview';
    return;
  }
}

window.addEventListener('message', (e) => {
  const frame = document.querySelector('iframe');
  const href = (e.data as { nativelocPreviewLink?: unknown })?.nativelocPreviewLink;
  if (!frame || e.source !== frame.contentWindow || typeof href !== 'string') return;
  // Only addresses inside the demo; anything else opens in a new tab.
  if (href.startsWith(`${location.origin}${BASE}`)) location.href = href;
  else if (/^https?:\/\//.test(href)) window.open(href, '_blank', 'noopener');
});
window.addEventListener('hashchange', () => void show());
void show();
