'use client';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { describeEvent } from '../lib/events.ts';
import type { DomainEvent } from '../lib/types.ts';

const GLYPH = { good: '✓', bad: '✕', warn: '!', info: '•', muted: '·' } as const;
const CHATTER = /^agent\.(message|tool_result)$/;
const LIMIT = 200;

const clock = (iso: string) => { const d = new Date(iso); return Number.isNaN(+d) ? '' : d.toLocaleTimeString([], { hour12: false }); };

export default function Timeline({ events }: { events: DomainEvent[] }) {
  const [hideChatter, setHideChatter] = useState(false);
  const [all, setAll] = useState(false);
  const shown = useMemo(() => {
    const f = hideChatter ? events.filter((e) => !CHATTER.test(e.type)) : events;
    return [...f].reverse();
  }, [events, hideChatter]);
  const visible = all ? shown : shown.slice(0, LIMIT);

  return (
    <section className="card" aria-labelledby="timeline-h">
      <div className="row spread">
        <h2 id="timeline-h">Timeline <span className="muted small">({events.length} events, newest first)</span></h2>
        <label className="row small"><input type="checkbox" checked={hideChatter} onChange={(e) => setHideChatter(e.target.checked)} /> Hide agent chatter</label>
      </div>
      {events.length === 0 && <p className="muted">No events yet.</p>}
      <ol className="timeline" aria-live="off" tabIndex={0} aria-label="Session events">
        {visible.map((e) => {
          const v = describeEvent(e);
          return (
            <li key={e.seq}>
              <span className="t" title={e.createdAt}>{clock(e.createdAt)}</span>
              <span className={`dot ${v.tone}`} aria-hidden="true">{GLYPH[v.tone]}</span>
              <div>
                <div><strong>{v.title}</strong> <span className="muted small">#{e.seq}</span>{e.runId && <> <Link className="small" href={`/runs/${e.runId}`}>run</Link></>}</div>
                {v.detail && <div className="detail">{v.detail}</div>}
              </div>
            </li>
          );
        })}
      </ol>
      {!all && shown.length > LIMIT && <p><button className="btn" onClick={() => setAll(true)}>Show all {shown.length} events</button></p>}
    </section>
  );
}
