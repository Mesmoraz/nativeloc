// Resolved only by the demo build (vite.config.ts aliases it to the server's app.ts), so the web app's
// typecheck doesn't pull in the server and its Node types.
declare module 'demo-server' {
  export function buildApp(opts: { dbPath: string; dataDir: string; fetch?: typeof fetch; allowPrivateSites?: boolean }): Promise<{ app: unknown }>;
}

declare module 'demo-server-mailer' {
  export interface OutgoingEmail {
    to: string;
    subject: string;
    body: string;
  }
  export function setMailer(m: { name: string; send(msg: OutgoingEmail): Promise<void> }): void;
}
