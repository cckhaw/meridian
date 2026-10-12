'use client';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

export type Theme = 'light' | 'dark';
const KEY = 'meridian-theme';
const Ctx = createContext<{ theme: Theme; toggle: () => void }>({ theme: 'light', toggle: () => {} });

/** Inline in <head> to set the class before first paint (default: light, regardless of OS setting). */
export const themeInitScript = `try{if(localStorage.getItem('${KEY}')==='dark')document.documentElement.classList.add('dark');if(localStorage.getItem('meridian-sidebar')==='hidden')document.documentElement.dataset.sidebar='hidden'}catch(e){}`;

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>('light');
  useEffect(() => { setTheme(document.documentElement.classList.contains('dark') ? 'dark' : 'light'); }, []);
  const toggle = useCallback(() => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.classList.toggle('dark', next === 'dark');
    try { localStorage.setItem(KEY, next); } catch { /* private mode */ }
    setTheme(next);
  }, [theme]);
  return <Ctx.Provider value={{ theme, toggle }}>{children}</Ctx.Provider>;
}
export const useTheme = () => useContext(Ctx);
