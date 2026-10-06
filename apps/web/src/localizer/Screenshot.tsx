import type { QueueItem } from '../api';

/** The device screen this string appears on, with the string's area highlighted. */
export function Screenshot({ shot }: { shot: QueueItem['screenshot'] }) {
  if (!shot) {
    return <div className="no-shot small">No screenshot for this text yet. Use the note and the original wording for context.</div>;
  }
  const pct = (v: number) => `${v * 100}%`;
  return (
    <figure style={{ margin: 0 }}>
      <a href={shot.url} target="_blank" rel="noreferrer" className="shot" style={{ display: 'block' }} title="Open full size">
        <img src={shot.url} alt={shot.label ?? 'Screen where this text appears'} width={shot.width} height={shot.height} />
        {shot.box && <div className="box" style={{ left: pct(shot.box.x), top: pct(shot.box.y), width: pct(shot.box.w), height: pct(shot.box.h) }} />}
      </a>
      <figcaption className="small muted" style={{ marginTop: 6 }}>
        {shot.box ? 'Highlighted: where this text appears' : 'This text appears on this screen'}
        {shot.label ? ` · ${shot.label}` : ''}
      </figcaption>
    </figure>
  );
}
