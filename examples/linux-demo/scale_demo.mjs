// Same demo as scale_demo.py using the JS SDK (Node on a Linux device).
//   node --import tsx examples/linux-demo/scale_demo.mjs es
import { join } from 'node:path';
import { NativeLoc } from '@nativeloc/sdk';
import { fileStorage } from '@nativeloc/sdk/node';

const locale = process.argv[2] ?? 'es';
const loc = await new NativeLoc({
  baseUrl: process.env.NATIVELOC_URL ?? 'http://localhost:4600',
  bundleToken: 'pb_demo_scale',
  locale,
  storage: fileStorage(join(import.meta.dirname, '.nativeloc-cache-js')),
  fallback: { en: { 'Place item on the scale': 'Place item on the scale' } },
}).init();

console.log(`bundle v${loc.version || '-'} (${locale})`);
console.log('='.repeat(40));
console.log(loc.t('Place item on the scale'));
console.log(loc.t('Weight: %s kg', { arg1: '0.42' }));
console.log(loc.t('%d label printed', { arg1: 3 }));
console.log(`[ ${loc.t('button\u0004Print label')} ]`);
console.log(loc.t('Hello %(name)s, you saved %(amount)s', { name: 'Sam', amount: '$1.20' }));
