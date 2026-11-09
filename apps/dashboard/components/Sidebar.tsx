'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { api } from '../lib/api.ts';
import { usePolling } from '../lib/hooks.ts';
import { isDemo } from '../lib/status.ts';
import type { SessionSummary } from '../lib/types.ts';
import { Ago, StatusBadge } from './small.tsx';

export default function Sidebar() {
  const pathname = usePathname();
  const list = usePolling(() => api<SessionSummary[]>('/sessions'), 4000, 'sidebar');
  const stale = list.error && list.data;

  return (
    <>
      <header>
        <Link href="/" className="brand">AI Control Center</Link>
        <Link href="/new" className="btn primary" style={{ justifyContent: 'center' }}>+ New session</Link>
      </header>
      <nav aria-label="Sessions">
        <div aria-live="polite" style={{ padding: '0 10px' }}>
          {list.error && !list.data && <div className="banner bad" role="alert">{list.error.message}</div>}
          {stale && <div className="banner warn">Showing stale data — last updated <Ago ms={list.updatedAt} />. {list.error!.message}</div>}
        </div>
        {list.loading && !list.data && <p className="muted small" style={{ padding: '0 14px' }}>Loading sessions…</p>}
        {list.data && list.data.length === 0 && <p className="muted small" style={{ padding: '8px 14px' }}>No sessions yet.</p>}
        <ul className="session-list">
          {list.data?.map(({ session, project, latestRun }) => (
            <li key={session.id}>
              <Link href={`/sessions/${session.id}`} className="session-link" aria-current={pathname === `/sessions/${session.id}` ? 'page' : undefined}>
                <span className="title" title={session.title}>{session.title}</span>
                <span className="meta">
                  <StatusBadge state={session.status} pulse />
                  {isDemo(session.title) && <span className="badge demo" title="Seeded demo data, not a real run">DEMO</span>}
                </span>
                <span className="meta">{project.name}{latestRun ? ` · ${latestRun.model}` : ''} · <Ago iso={session.updatedAt} /></span>
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </>
  );
}
