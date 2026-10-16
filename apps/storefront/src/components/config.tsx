'use client';
import { formatMoney, type RegionalSettings } from '@meridian/types';
import { createContext, useContext, type ReactNode } from 'react';

export interface StoreConfig {
  brand: { name: string; theme: string; logo: { sha256: string } | null; favicon?: { sha256: string } | null };
  regional: RegionalSettings;
  kyc: { mode: string; minAge: number; idTypes: string[]; requiresBack: string[]; maxDocumentBytes: number; methods?: { photos: true; ocr: boolean; mydigitalid: { store: boolean; crm: boolean; label: string } } };
  terms: { version: string; termsUrl: string | null; privacyUrl: string | null };
  payment: { gateways: Array<{ id: string; label: string }>; default: string | null };
  modules?: { fiberCoverage?: boolean };
  typeConflicts?: Array<[string, string]>;
}
const Ctx = createContext<StoreConfig | null>(null);
export const ConfigProvider = ({ value, children }: { value: StoreConfig; children: ReactNode }) => <Ctx.Provider value={value}>{children}</Ctx.Provider>;
export function useConfig() {
  const c = useContext(Ctx);
  if (!c) throw new Error('ConfigProvider missing');
  return { ...c, money: (minor: number | null | undefined) => formatMoney(minor, c.regional) };
}
