/**
 * A pretend self-checkout kiosk (think: Chromium in kiosk mode on a Linux panel) that
 * renders every string through the NativeLoc SDK and can upload its own screen with
 * exact text positions.
 */
import { captureContext, localStorageStorage, NativeLoc, type CaptureBox } from '@nativeloc/sdk';

const PROJECT_ID = 1;
const BUNDLE_TOKEN = new URLSearchParams(location.search).get('bundle') ?? 'pb_demo_kiosk';
const LOCALES = ['en', 'es', 'fr', 'ja', 'ru'];

const canvas = document.getElementById('screen-canvas') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const $ = (id: string) => document.getElementById(id)!;

const loc = new NativeLoc({
  baseUrl: location.origin,
  bundleToken: BUNDLE_TOKEN,
  locale: 'es',
  storage: localStorageStorage(),
  // What ships inside the app image, so the kiosk works even before its first download.
  fallback: { en: { welcome_title: 'Welcome! Tap to start', checkout: 'Checkout' } },
});

let screen: 'home' | 'payment' = 'home';
let boxes: CaptureBox[] = [];

const FONT = 'system-ui, "Noto Sans", "Noto Sans CJK JP", sans-serif';

/** Draw a translated string and remember where it landed (for capture). */
function text(key: string, x: number, y: number, size: number, opts: { args?: Record<string, unknown>; color?: string; weight?: number; align?: CanvasTextAlign; maxWidth?: number } = {}) {
  const value = loc.t(key, opts.args);
  ctx.font = `${opts.weight ?? 400} ${size}px ${FONT}`;
  ctx.fillStyle = opts.color ?? '#1c2420';
  ctx.textAlign = opts.align ?? 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(value, x, y, opts.maxWidth);
  const w = Math.min(ctx.measureText(value).width, opts.maxWidth ?? Infinity);
  const left = opts.align === 'center' ? x - w / 2 : opts.align === 'right' ? x - w : x;
  boxes.push({ key, x: Math.round(left - 6), y: Math.round(y - 6), w: Math.round(w + 12), h: Math.round(size * 1.3 + 12) });
  return w;
}

function rect(x: number, y: number, w: number, h: number, fill: string, r = 16) {
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.fill();
}

function drawHome() {
  text('welcome_title', 60, 120, 54, { weight: 700 });
  text('welcome_back', 60, 196, 28, { args: { arg1: 'Sam' }, color: '#3d4a44' });

  // department tiles
  const tiles = ['#d8f0ec', '#fde9d2', '#e6eefc'];
  for (let i = 0; i < 3; i++) {
    rect(60 + i * 250, 280, 230, 160, tiles[i]);
    text(`departments[${i}]`, 60 + i * 250 + 115, 340, 26, { weight: 600, align: 'center', maxWidth: 210 });
  }

  // promo banner
  rect(60, 470, 730, 90, '#0f766e');
  text('discount', 90, 498, 30, { args: { arg1: 20 }, color: '#fff', weight: 700 });

  // cart panel
  rect(840, 120, 380, 560, '#f3f5f2');
  text('cart_items', 870, 160, 26, { args: { arg1: 3 }, weight: 600 });
  ctx.fillStyle = '#c9d0cb';
  ctx.fillRect(870, 215, 320, 2);
  ['Bananas  $1.20', 'Sourdough  $5.50', 'Eggs (12)  $5.70'].forEach((line, i) => {
    ctx.font = `22px ${FONT}`;
    ctx.fillStyle = '#3d4a44';
    ctx.textAlign = 'left';
    ctx.fillText(line, 870, 240 + i * 44);
  });
  text('cart_total', 870, 400, 30, { args: { arg1: '$12.40' }, weight: 700 });
  rect(870, 560, 320, 90, '#0f766e', 45);
  text('checkout', 1030, 588, 32, { color: '#fff', weight: 700, align: 'center', maxWidth: 290 });

  text('session_timeout', 60, 610, 22, { args: { arg1: 10 }, color: '#9a5b00' });
}

function drawPayment() {
  rect(240, 140, 800, 220, '#fde8e6');
  text('payment_declined', 640, 210, 30, { color: '#b42318', weight: 600, align: 'center', maxWidth: 740 });
  text('receipt_question', 640, 430, 40, { weight: 700, align: 'center', maxWidth: 1000 });
  rect(380, 520, 240, 100, '#0f766e', 50);
  text('yes', 500, 552, 34, { color: '#fff', weight: 700, align: 'center' });
  rect(660, 520, 240, 100, '#dde1dc', 50);
  text('no', 780, 552, 34, { weight: 700, align: 'center' });
}

function draw() {
  boxes = [];
  loc.beginScreen();
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  // header
  ctx.fillStyle = '#1c2420';
  ctx.fillRect(0, 0, canvas.width, 72);
  ctx.font = `700 28px ${FONT}`;
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText('🥬 FreshMart', 30, 37);
  text('change_language', 1250, 24, 22, { color: '#cfe', align: 'right' });

  if (screen === 'home') drawHome();
  else drawPayment();
  $('version').textContent = loc.version ? `bundle v${loc.version} · ${loc.locale}` : 'offline: built-in text';
}

// ----- simulator controls -----
for (const l of LOCALES) {
  const b = document.createElement('button');
  b.textContent = l.toUpperCase();
  b.onclick = () => void loc.setLocale(l).then(draw);
  $('langs').append(b, ' ');
}
($('screen') as HTMLSelectElement).onchange = (e) => {
  screen = (e.target as HTMLSelectElement).value as typeof screen;
  draw();
};

$('capture').onclick = async () => {
  const token = ($('token') as HTMLInputElement).value.trim();
  if (!token) return void ($('status').textContent = 'Paste a push token first.');
  // Capture the source-language screen: that is what localizers compare against.
  const prev = loc.locale;
  await loc.setLocale('en');
  draw();
  const image = await new Promise<Blob>((r) => canvas.toBlob((b) => r(b!), 'image/png'));
  const captured = boxes;
  await loc.setLocale(prev);
  draw();
  try {
    const res = await captureContext({ baseUrl: location.origin, projectId: PROJECT_ID, pushToken: token, image, label: screen === 'home' ? 'Kiosk: home / cart' : 'Kiosk: payment', keys: captured });
    $('status').textContent = `Uploaded screenshot #${res.id} with ${captured.length} text boxes.`;
  } catch (e) {
    $('status').textContent = (e as Error).message;
  }
};

loc.onChange(draw);
await loc.init();
loc.startPolling(15_000);
draw();
