export const label = (s: string) => s.toLowerCase().replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
export const dt = (s?: string | null) => (s ? new Date(s).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—');
export const money = (minor: number, currency = 'SGD') => new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(minor / 100);
export const tiers = (a?: number[] | null) => (a?.length ? a.map((x) => (x >= 1000 ? `${x / 1000} Gbps` : `${x} Mbps`)).join(', ') : '—');
export const parseTiers = (s: string): number[] => s.split(/[,;\s]+/).filter(Boolean).map(Number).filter((n) => Number.isInteger(n) && n > 0);
