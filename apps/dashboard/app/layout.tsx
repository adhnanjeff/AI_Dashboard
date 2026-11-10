import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Sidebar from '../components/Sidebar.tsx';
import './globals.css';

export const metadata: Metadata = { title: 'AI Engineering Control Center', description: 'Monitor and control AI coding sessions' };

// Runs before first paint so a remembered Light/Dark choice never flashes the wrong theme.
const THEME_INIT = `try{var t=localStorage.getItem('theme');if(t==='light'||t==='dark')document.documentElement.setAttribute('data-theme',t)}catch(e){}`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: THEME_INIT }} /></head>
      <body>
        <a className="skip" href="#main">Skip to content</a>
        <div className="shell">
          <aside className="sidebar" aria-label="Sidebar"><Sidebar /></aside>
          <main id="main" tabIndex={-1}>{children}</main>
        </div>
      </body>
    </html>
  );
}
