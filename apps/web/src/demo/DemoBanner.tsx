import { useEffect, useRef, useState } from 'react';
import { INBOX_EVENT, readInbox, type DemoEmail } from './inbox';

/** Plain-text email with its links clickable. */
function Body({ text }: { text: string }) {
  return (
    <p className="demo-mail-body">
      {text.split(/(https?:\/\/\S+)/).map((part, i) => (i % 2 ? <a key={i} href={part}>{part}</a> : part))}
    </p>
  );
}

/** A strip on the online demo: what it is, the inbox for emails the demo sends, and a way to start over. */
export function DemoBanner() {
  const [busy, setBusy] = useState(false);
  const [inbox, setInbox] = useState<DemoEmail[]>(readInbox);
  const [open, setOpen] = useState(false);
  const count = useRef(inbox.length);

  useEffect(() => {
    const update = () => {
      const mail = readInbox();
      // A new email opens the inbox, like a notification.
      if (mail.length > count.current) setOpen(true);
      count.current = mail.length;
      setInbox(mail);
    };
    window.addEventListener(INBOX_EVENT, update);
    return () => window.removeEventListener(INBOX_EVENT, update);
  }, []);

  const reset = async () => {
    if (!confirm('Start the demo over? Everything you changed here goes back to the demo data.')) return;
    setBusy(true);
    await (await import('./runtime')).resetDemo();
  };

  return (
    <div className="demo-banner" role="note">
      <div className="demo-banner-row">
        <span>
          <b>Online demo.</b> NativeLoc runs in your browser with sample data; your changes stay on this device.
        </span>
        <button type="button" className="link" onClick={() => setOpen(!open)} aria-expanded={open}>
          Inbox{inbox.length ? ` (${inbox.length})` : ''}
        </button>
        <button type="button" className="link" disabled={busy} onClick={() => void reset()}>
          Reset demo
        </button>
      </div>
      {open && (
        <div className="demo-inbox">
          {inbox.length === 0 && <p className="muted">No emails yet. Emails NativeLoc sends, like the sign-up confirmation, show up here.</p>}
          {inbox.map((m) => (
            <div key={m.at + m.subject} className="demo-mail">
              <div>
                <b>{m.subject}</b> <span className="muted">to {m.to}</span>
              </div>
              <Body text={m.body} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
