'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { api } from '../lib/api.ts';
import { usePolling } from '../lib/hooks.ts';
import type { ApprovalView } from '../lib/types.ts';
import ThemeToggle from './ThemeToggle.tsx';

const I = (d: string) => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>;
const NAV = [
  { href: '/', label: 'Overview', icon: 'M3 3h7v9H3zM14 3h7v5h-7zM14 12h7v9h-7zM3 16h7v5H3z', exact: true },
  { href: '/factory', label: 'Factory', icon: 'M2 20h20M4 20V9l5 3V9l5 3V6h3v14' },
  { href: '/workflows', label: 'Workflows', icon: 'M6 3v12M18 9v12M6 15a3 3 0 1 0 0 .01M18 9a3 3 0 1 0 0-.01' },
  { href: '/graph', label: 'Code graph', icon: 'M12 5v6M12 11l-6 6M12 11l6 6M12 3.5a1.5 1.5 0 1 0 0 .01M5 19a1.5 1.5 0 1 0 0 .01M19 19a1.5 1.5 0 1 0 0 .01' },
  { href: '/approvals', label: 'Approvals', icon: 'M9 12l2 2 4-4M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z' },
  { href: '/analytics', label: 'Analytics', icon: 'M3 3v18h18M7 15l4-5 3 3 5-7' },
  { href: '/usage', label: 'Usage', icon: 'M4 20V10M10 20V4M16 20v-7M22 20H2' },
  { href: '/providers', label: 'Providers', icon: 'M3 5h18v6H3zM3 13h18v6H3zM7 8h.01M7 16h.01' },
  { href: '/data', label: 'Data', icon: 'M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6' },
];

/** Top bar: brand, main navigation, new-session action and theme. */
export default function Header() {
  const pathname = usePathname();
  const pending = usePolling(() => api<ApprovalView[]>('/approvals?status=pending'), 5000, 'hdr-approvals').data?.length ?? 0;
  return (
    <header className="topbar">
      <Link href="/" className="brand">
        <span className="logo" aria-hidden="true"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3 3 8l9 5 9-5-9-5Z" /><path d="m3 13 9 5 9-5" /><path d="m3 17.5 9 5 9-5" opacity=".55" /></svg></span>
        <span>Control Center</span>
      </Link>
      <nav className="topnav" aria-label="Main">
        {NAV.map((n) => {
          const on = n.exact ? pathname === n.href : pathname === n.href || pathname.startsWith(n.href + '/');
          return <Link key={n.href} href={n.href} className="nav-link" aria-current={on ? 'page' : undefined}>{I(n.icon)}{n.label}{n.href === '/approvals' && pending > 0 ? <span className="count-pill" aria-label={`${pending} waiting`}>{pending}</span> : null}</Link>;
        })}
      </nav>
      <div className="top-actions">
        <ThemeToggle />
        <Link href="/new" className="btn primary">+ New session</Link>
      </div>
    </header>
  );
}
