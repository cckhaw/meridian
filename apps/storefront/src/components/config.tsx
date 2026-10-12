'use client';
import { formatMoney, type RegionalSettings } from '@meridian/types';
import { createContext, useContext, type ReactNode } from 'react';

export interface StoreConfig {
  brand: { name: string; theme: string; logo: { sha256: string } | null };
  regional: RegionalSettings;
  kyc: { mode: string; minAge: number; idTypes: string[]; requiresBack: string[]; maxDocumentBytes: number };
  terms: { version: string; termsUrl: string | null; privacyUrl: string | null };
  payment: { gateways: Array<{ id: string; label: string }>; default: string | null };
}
const Ctx = createContext<StoreConfig | null>(null);
export const ConfigProvider = ({ value, children }: { value: StoreConfig; children: ReactNode }) => <Ctx.Provider value={value}>{children}</Ctx.Provider>;
export function useConfig() {
  const c = useContext(Ctx);
  if (!c) throw new Error('ConfigProvider missing');
  return { ...c, money: (minor: number | null | undefined) => formatMoney(minor, c.regional) };
}
