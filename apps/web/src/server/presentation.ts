import { DEFAULT_REGIONAL, DEFAULT_THEME, themeCss, type RegionalSettings, type ThemeId } from '@meridian/types';
import { DEFAULT_BRAND_NAME, getBranding, getDb, getRegional } from '@meridian/core';

export interface Presentation { name: string; theme: ThemeId; logoUrl: string | null; regional: RegionalSettings; css: string }

/**
 * Brand, theme and number/date format for the root layout. A database hiccup must not take the whole UI down, so this falls back to defaults
 * (the API itself still reports the real error).
 */
export async function loadPresentation(): Promise<Presentation> {
  try {
    const db = await getDb();
    const [b, regional] = await Promise.all([getBranding(db), getRegional(db)]);
    return { name: b.name, theme: b.theme, logoUrl: b.logo ? `/api/branding/logo?v=${b.logo.sha256.slice(0, 12)}` : null, regional, css: themeCss(b.theme) };
  } catch {
    return { name: DEFAULT_BRAND_NAME, theme: DEFAULT_THEME, logoUrl: null, regional: DEFAULT_REGIONAL, css: themeCss(DEFAULT_THEME) };
  }
}
