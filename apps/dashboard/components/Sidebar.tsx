'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { api } from '../lib/api.ts';
import { usePolling } from '../lib/hooks.ts';
import { isDemo } from '../lib/status.ts';
import type { SessionSummary } from '../lib/types.ts';
import { Ago, StatusBadge } from './small.tsx';
import ThemeToggle from './ThemeToggle.tsx';

const Logo = () => (
  <span className="logo" aria-hidden="true">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3 3 8l9 5 9-5-9-5Z" /><path d="m3 13 9 5 9-5" /><path d="m3 17.5 9 5 9-5" opacity=".55" />
    </svg>
  </span>
);

export default function Sidebar() {
  const pathname = usePathname();
  const list = usePolling(() => api<SessionSummary[]>('/sessions'), 4000, 'sidebar');
  const stale = list.error && list.data;

  return (
    <>
      <header>
        <Link href="/" className="brand"><Logo /><span>AI Control Center<small>Local engineering orchestrator</small></span></Link>
        <Link href="/new" className="btn primary">+ New session</Link>
      </header>
      <div className="side-nav">
        <Link href="/" className="nav-link" aria-current={pathname === '/' ? 'page' : undefined}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="9" rx="1.5" /><rect x="14" y="3" width="7" height="5" rx="1.5" /><rect x="14" y="12" width="7" height="9" rx="1.5" /><rect x="3" y="16" width="7" height="5" rx="1.5" /></svg>
          Overview
        </Link>
      </div>
      <div className="side-label" id="sessions-label">Sessions</div>
      <nav aria-labelledby="sessions-label">
        <div aria-live="polite" style={{ padding: '0 10px' }}>
          {list.error && !list.data && <div className="banner bad" role="alert">{list.error.message}</div>}
          {stale && <div className="banner warn">Showing stale data — last updated <Ago ms={list.updatedAt} />. {list.error!.message}</div>}
        </div>
        {list.loading && !list.data && <p className="muted small" style={{ padding: '0 18px' }}>Loading sessions…</p>}
        {list.data && list.data.length === 0 && <p className="muted small" style={{ padding: '4px 18px' }}>No sessions yet.</p>}
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
      <div className="side-foot"><ThemeToggle /></div>
    </>
  );
}
