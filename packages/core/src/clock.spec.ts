import { describe, expect, it } from 'vitest';
import { dayOf, today } from './dates.js';

describe('the test clock', () => {
  it('never starts on the 29th to 31st, which a bill cycle cannot use, and still moves forward at full resolution', async () => {
    expect(dayOf(today())).toBeLessThanOrEqual(28);   // the real date, or the 28th of the same month when the real one is later (test-setup/clock.ts)
    const a = Date.now();
    await new Promise((r) => setTimeout(r, 5));
    expect(Date.now() - a).toBeGreaterThanOrEqual(4);
    expect(new Date().getTime() - Date.now()).toBeLessThan(50);
  });
});
