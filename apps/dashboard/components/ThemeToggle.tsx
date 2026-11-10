'use client';
import { useEffect, useState } from 'react';

type Theme = 'system' | 'light' | 'dark';
const OPTIONS: { id: Theme; label: string }[] = [{ id: 'system', label: 'Auto' }, { id: 'light', label: 'Light' }, { id: 'dark', label: 'Dark' }];

/** Auto follows the operating system. The choice is remembered in this browser only. */
export default function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>('system');
  useEffect(() => {
    try { const t = localStorage.getItem('theme'); if (t === 'light' || t === 'dark') setTheme(t); } catch { /* storage unavailable: stay on Auto */ }
  }, []);
  function pick(t: Theme) {
    setTheme(t);
    if (t === 'system') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', t);
    try { if (t === 'system') localStorage.removeItem('theme'); else localStorage.setItem('theme', t); } catch { /* ignore */ }
  }
  return (
    <div className="seg" role="group" aria-label="Colour theme">
      {OPTIONS.map((o) => <button key={o.id} type="button" aria-pressed={theme === o.id} onClick={() => pick(o.id)}>{o.label}</button>)}
    </div>
  );
}
