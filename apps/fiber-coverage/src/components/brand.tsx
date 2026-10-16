'use client';
import { createContext, useContext, type ReactNode } from 'react';

export interface BrandView { name: string; logoUrl: string | null }
const Ctx = createContext<BrandView>({ name: 'Meridian', logoUrl: null });
export const BrandProvider = ({ value, children }: { value: BrandView; children: ReactNode }) => <Ctx.Provider value={value}>{children}</Ctx.Provider>;
export const useBrand = () => useContext(Ctx);

/** The operator's logo (or their name when there is none), the same mark the CRM and the shop show. */
export function BrandMark({ size = 'sm' }: { size?: 'sm' | 'lg' }) {
  const b = useBrand();
  return b.logoUrl
    // eslint-disable-next-line @next/next/no-img-element
    ? <img src={b.logoUrl} alt={b.name} className={size === 'lg' ? 'mx-auto max-h-20 w-auto max-w-[300px] object-contain' : 'max-h-10 w-auto max-w-[200px] object-contain'} />
    : <span className={size === 'lg' ? 'text-title1 font-bold' : 'text-title3 font-bold'}>{b.name}</span>;
}
