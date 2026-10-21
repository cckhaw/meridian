import { describe, expect, it } from 'vitest';
import { SECTIONS as INTEGRATION_SECTIONS } from '../integrations/sections';
import { MOVED_TO_INTEGRATION, SECTIONS, sectionById } from './sections';

describe('Settings sections that moved to Integration', () => {
  it('no longer lists Device financing, and sends its old address to the credit bureau card', () => {
    expect(sectionById('device-financing')).toBeUndefined();
    expect(SECTIONS.some((s) => /financing/i.test(s.label))).toBe(false);
    const to = new URL(MOVED_TO_INTEGRATION['device-financing']!, 'http://x');
    expect(to.pathname).toBe('/admin/integrations');
    expect(INTEGRATION_SECTIONS.find((s) => s.id === to.searchParams.get('section'))?.groups).toContain('Identity, credit and collections');
    expect(to.searchParams.get('item')).toBe('credit-bureau');
  });
  it('keeps every moved id out of the Settings menu', () => {
    for (const id of Object.keys(MOVED_TO_INTEGRATION)) expect(sectionById(id), id).toBeUndefined();
  });
});
