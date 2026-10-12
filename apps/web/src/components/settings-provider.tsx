'use client';
import type { RegionalSettings } from '@meridian/types';
import { createContext, useContext, type ReactNode } from 'react';
import { setRegional } from '@/lib/format';

export interface ClientPresentation { name: string; logoUrl: string | null; regional: RegionalSettings }
const Ctx = createContext<ClientPresentation>({ name: 'Meridian', logoUrl: null, regional: undefined as never });
export const useBrand = () => { const p = useContext(Ctx); return { name: p.name, logoUrl: p.logoUrl }; };

/** Installs the operator's regional format before any child renders, so `money()` / `d()` are right on the very first (server) render too. */
export function SettingsProvider({ value, children }: { value: ClientPresentation; children: ReactNode }) {
  setRegional(value.regional);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
