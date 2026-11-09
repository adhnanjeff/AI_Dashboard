import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Sidebar from '../components/Sidebar.tsx';
import './globals.css';

export const metadata: Metadata = { title: 'AI Engineering Control Center', description: 'Monitor and control AI coding sessions' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
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
