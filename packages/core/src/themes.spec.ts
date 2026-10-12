import { describe, expect, it } from 'vitest';
import { contrast, THEME_IDS, THEMES, themeCss, type Rgb } from './themes.js';

const SURFACES = { light: { bg: [255, 255, 255] as Rgb, surface2: [250, 250, 252] as Rgb }, dark: { bg: [0, 0, 0] as Rgb, surface: [28, 28, 30] as Rgb, surface2: [44, 44, 46] as Rgb } };

describe('themes', () => {
  it('offers seven distinct colour variances', () => {
    expect(THEME_IDS).toHaveLength(7);
    const accents = new Set(THEME_IDS.map((t) => THEMES[t].light.accent.join()));
    expect(accents.size).toBe(7);
  });

  for (const id of THEME_IDS) {
    it(`${id} meets WCAG AA (4.5:1) for buttons and accent text in light and dark`, () => {
      const t = THEMES[id];
      for (const mode of ['light', 'dark'] as const) {
        const m = t[mode];
        expect(contrast(m.accentFg, m.accent), `${id} ${mode} button text`).toBeGreaterThanOrEqual(4.5);
        for (const [name, bg] of Object.entries(SURFACES[mode])) expect(contrast(m.accent, bg), `${id} ${mode} accent on ${name}`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(m.accent, m.grouped), `${id} ${mode} accent on page background`).toBeGreaterThanOrEqual(4.5);
      }
    });
  }

  it('renders css from the fixed table only', () => {
    const css = themeCss('teal');
    expect(css).toContain('--accent:0 121 107');
    expect(css).toMatch(/^html:root\{[^}]+\}html\.dark\{[^}]+\}$/);
    expect(themeCss('nope' as never)).toBe(themeCss('ocean'));
  });
});
