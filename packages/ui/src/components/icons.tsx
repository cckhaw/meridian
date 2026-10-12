import type { ReactNode, SVGProps } from 'react';

/**
 * Line icons drawn on a 24px grid with one stroke weight, in the spirit of SF Symbols: each one pictures what the module does.
 * They inherit `currentColor`, so they follow text colour, the accent and dark mode.
 */
const G: Record<string, ReactNode> = {
  // dashboard: four tiles of different sizes
  overview: <><rect x="3" y="3" width="8" height="10" rx="2" /><rect x="13" y="3" width="8" height="6" rx="2" /><rect x="13" y="11" width="8" height="10" rx="2" /><rect x="3" y="15" width="8" height="6" rx="2" /></>,
  // two people
  customers: <><circle cx="9" cy="8" r="3.2" /><path d="M3.5 19c0-3.2 2.5-5.2 5.5-5.2s5.5 2 5.5 5.2" /><circle cx="17" cy="9" r="2.5" /><path d="M16.2 14.1c2.7-.1 4.8 1.5 4.8 4.5" /></>,
  // shopping bag with a plus: start a new order
  sell: <><path d="M5 8h14l-1 12H6L5 8z" /><path d="M9 8V6.5a3 3 0 0 1 6 0V8" /><path d="M12 12v4M10 14h4" /></>,
  // a person with a verified badge: serving a customer in person
  assisted: <><circle cx="10" cy="8" r="3.2" /><path d="M4 19c0-3.3 2.7-5.3 6-5.3 1.3 0 2.5.3 3.5.8" /><circle cx="18" cy="16.5" r="3.5" /><path d="m16.4 16.5 1.2 1.2 2.1-2.4" /></>,
  // parcel
  orders: <><path d="M12 3 20 7v10l-8 4-8-4V7l8-4z" /><path d="m4 7 8 4 8-4M12 11v10" /></>,
  // receipt
  billing: <><path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3z" /><path d="M9 8h6M9 12h6" /></>,
  // headset: support
  cases: <><path d="M4 14v-2a8 8 0 0 1 16 0v2" /><rect x="3" y="13" width="4" height="6" rx="1.5" /><rect x="17" y="13" width="4" height="6" rx="1.5" /><path d="M19 19c0 1.5-1.5 2.5-4 2.5h-2" /></>,
  // ID card
  kyc: <><rect x="3" y="5" width="18" height="14" rx="2.5" /><circle cx="9" cy="11" r="2" /><path d="M6 16c.4-1.6 1.6-2.5 3-2.5s2.6.9 3 2.5M14.5 10H18M14.5 13.5H17" /></>,
  // swap: a number moving between operators
  mnp: <><path d="M4 8h13l-3-3M20 16H7l3 3" /></>,
  // price tag
  catalog: <><path d="M3 12.5V4h8.5l9 9a1.5 1.5 0 0 1 0 2.1l-6.4 6.4a1.5 1.5 0 0 1-2.1 0L3 12.5z" /><circle cx="7.5" cy="8.5" r="1.3" /></>,
  // warehouse
  inventory: <><path d="M3 10 12 4l9 6v10H3V10z" /><path d="M8 20v-6h8v6M8 17h8" /></>,
  // banknote
  finance: <><rect x="3" y="6" width="18" height="12" rx="2" /><circle cx="12" cy="12" r="2.8" /><path d="M6.5 12h.01M17.5 12h.01" /></>,
  // percent badge
  commission: <><circle cx="12" cy="12" r="9" /><path d="m9 15 6-6" /><circle cx="9.2" cy="9.2" r="1.2" /><circle cx="14.8" cy="14.8" r="1.2" /></>,
  // shield with a person: who can do what
  users: <><path d="M12 3 19 6v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6l7-3z" /><circle cx="12" cy="10" r="2.2" /><path d="M8.5 16c.6-1.6 1.9-2.4 3.5-2.4s2.9.8 3.5 2.4" /></>,
  // preferences
  settings: <><path d="M4 7h9M17 7h3M4 17h3M11 17h9" /><circle cx="15" cy="7" r="2" /><circle cx="9" cy="17" r="2" /></>,
  // history: who did what, when
  audit: <><path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1" /><path d="M3 4.5v4h4M12 7.5V12l3 2" /></>,
  account: <><circle cx="12" cy="12" r="9" /><circle cx="12" cy="10" r="3" /><path d="M6.5 18c1-2.3 3-3.5 5.5-3.5s4.5 1.2 5.5 3.5" /></>,
  // chrome
  sidebar: <><rect x="3" y="5" width="18" height="14" rx="3" /><path d="M9.5 5v14" /></>,
  more: <><circle cx="6" cy="12" r="1.4" /><circle cx="12" cy="12" r="1.4" /><circle cx="18" cy="12" r="1.4" /></>,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4" /></>,
  moon: <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />,
  key: <><circle cx="8" cy="15" r="4" /><path d="m11 12 8-8M16 7l3 3" /></>,
  signout: <><path d="M10 4H5v16h5M15 8l4 4-4 4M19 12H9" /></>,
  close: <path d="m6 6 12 12M18 6 6 18" />,
  search: <><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4.5 4.5" /></>,
  chevron: <path d="m9 6 6 6-6 6" />,
};

/** Legacy names the server may still send, mapped to the icon that pictures the module. */
const ALIAS: Record<string, string> = { house: 'overview', person: 'customers', bag: 'sell', check: 'assisted', box: 'orders', doc: 'billing', bubble: 'cases', shield: 'kyc', swap: 'mnp', grid: 'catalog', cube: 'inventory', ledger: 'finance', coins: 'commission', people: 'users', gear: 'settings', list: 'audit' };

export type IconName = keyof typeof G;
export function Icon({ name, size = 22, ...p }: { name: string; size?: number } & Omit<SVGProps<SVGSVGElement>, 'name'>) {
  const body = G[name] ?? G[ALIAS[name] ?? ''] ?? <circle cx="12" cy="12" r="4" />;
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable="false" {...p}>{body}</svg>
  );
}
