'use client';
import type { RegionalSettings } from '@meridian/types';
import { createContext, useContext, type ReactNode } from 'react';
import { setRegional } from '@/lib/format';

export interface ClientPresentation { name: string; logoUrl: string | null; regional: RegionalSettings }
const Ctx = createContext<ClientPresentation>({ name: 'Meridian', logoUrl: null, regional: undefined as never });
/** The operator's regional settings (currency, dial code, formats) for screens that show examples or hints. */
export const useRegional = () => useContext(Ctx).regional;
export const useBrand = () => { const p = useContext(Ctx); return { name: p.name, logoUrl: p.logoUrl }; };

/** Installs the operator's regional format before any child renders, so `money()` / `d()` are right on the very first (server) render too. */
export function SettingsProvider({ value, children }: { value: ClientPresentation; children: ReactNode }) {
  setRegional(value.regional);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
