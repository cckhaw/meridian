/**
 * Eight portal colour themes, each a distinct hue family (ocean, teal, forest, sunset, autumn, violet, mocha, sunflower).
 * Every pair is checked for WCAG AA contrast (4.5:1) in themes.spec.ts so a theme can never make text unreadable.
 * Values are space-separated RGB channels, matching tokens.css.
 */
export type Rgb = [number, number, number];
export interface ThemeMode { accent: Rgb; accentFg: Rgb; /** page background behind cards */ grouped: Rgb }
export interface Theme { id: ThemeId; name: string; mood: string; light: ThemeMode; dark: ThemeMode }

export const THEME_IDS = ['ocean', 'teal', 'forest', 'sunset', 'autumn', 'violet', 'mocha', 'sunflower'] as const;
export type ThemeId = (typeof THEME_IDS)[number];
export const DEFAULT_THEME: ThemeId = 'ocean';

export const THEMES: Record<ThemeId, Theme> = {
  ocean:  { id: 'ocean',  name: 'Ocean',  mood: 'Trust and clarity',     light: { accent: [0, 102, 204],  accentFg: [255, 255, 255], grouped: [242, 242, 247] }, dark: { accent: [64, 156, 255], accentFg: [0, 0, 0], grouped: [0, 0, 0] } },
  teal:   { id: 'teal',   name: 'Teal',   mood: 'Calm and modern',       light: { accent: [0, 121, 107],  accentFg: [255, 255, 255], grouped: [237, 246, 245] }, dark: { accent: [64, 208, 190], accentFg: [0, 0, 0], grouped: [0, 0, 0] } },
  forest: { id: 'forest', name: 'Forest', mood: 'Growth and reliability', light: { accent: [30, 120, 60],  accentFg: [255, 255, 255], grouped: [240, 246, 240] }, dark: { accent: [100, 210, 130], accentFg: [0, 0, 0], grouped: [0, 0, 0] } },
  sunset: { id: 'sunset', name: 'Sunset', mood: 'Warm and expressive',   light: { accent: [190, 24, 93],  accentFg: [255, 255, 255], grouped: [250, 241, 246] }, dark: { accent: [255, 120, 170], accentFg: [0, 0, 0], grouped: [0, 0, 0] } },
  autumn: { id: 'autumn', name: 'Autumn', mood: 'Energetic and friendly', light: { accent: [176, 68, 0],  accentFg: [255, 255, 255], grouped: [250, 244, 237] }, dark: { accent: [255, 160, 64], accentFg: [0, 0, 0], grouped: [0, 0, 0] } },
  violet: { id: 'violet', name: 'Violet', mood: 'Creative and premium',  light: { accent: [109, 40, 217], accentFg: [255, 255, 255], grouped: [245, 242, 251] }, dark: { accent: [176, 140, 255], accentFg: [0, 0, 0], grouped: [0, 0, 0] } },
  mocha:  { id: 'mocha',  name: 'Mocha',  mood: 'Grounded and refined',  light: { accent: [112, 76, 52],  accentFg: [255, 255, 255], grouped: [246, 243, 240] }, dark: { accent: [214, 170, 130], accentFg: [0, 0, 0], grouped: [0, 0, 0] } },
  // Yellow cannot carry white text at AA in light mode, so the light accent is a deep gold; dark mode uses the bright yellow with black text.
  sunflower: { id: 'sunflower', name: 'Sunflower', mood: 'Bright and optimistic', light: { accent: [138, 100, 0], accentFg: [255, 255, 255], grouped: [252, 247, 230] }, dark: { accent: [255, 214, 10], accentFg: [0, 0, 0], grouped: [0, 0, 0] } },
};
export const isThemeId = (t: string): t is ThemeId => (THEME_IDS as readonly string[]).includes(t);

/** CSS variable overrides for a theme. Only built from the fixed table above, never from user input. */
export function themeCss(id: ThemeId): string {
  const t = THEMES[id] ?? THEMES[DEFAULT_THEME];
  const v = (m: ThemeMode) => `--accent:${m.accent.join(' ')};--accent-label:${m.accentFg.join(' ')};--bg-grouped:${m.grouped.join(' ')};`;
  return `html:root{${v(t.light)}}html.dark{${v(t.dark)}}`;
}

// ── contrast (WCAG 2.x) ──
const lin = (c: number) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
export const luminance = ([r, g, b]: Rgb) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
export function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
