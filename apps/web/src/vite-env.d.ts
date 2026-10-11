/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** "1" in the online demo build (`vite build --mode demo`). */
  readonly VITE_DEMO?: string;
  /** Identifies the demo's seeded data; a new value starts visitors over. */
  readonly VITE_DEMO_SEED?: string;
}
