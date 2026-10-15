import { invalid } from '../errors.js';
import type { WfmConnector, WfmSlot, WfmVendor } from './types.js';

const HOUR = 3_600_000, DAY = 86_400_000;
/** The pretend WFM's working windows (UTC): two a day on weekdays. */
const WINDOWS: Array<[number, number]> = [[9, 12], [13, 17]];

/** A pretend field-service system for development and demos: weekday slots, a capacity per slot, instant or asynchronous confirmation, or refusing everything. */
export const wfmSimulatorVendor: WfmVendor = {
  id: 'simulator',
  label: 'Simulator (no real system)',
  summary: 'Offers two slots a weekday (09–12 and 13–17 UTC), holds and confirms what is asked, and gives back made-up job numbers. Callbacks are sent to Meridian by you, signed with the webhook secret.',
  real: false,
  fields: [
    { key: 'mode', label: 'Behaviour', kind: 'select', options: [{ value: 'OK', label: 'Confirm at once' }, { value: 'ASYNC', label: 'Accept, and assign a technician later (by callback)' }, { value: 'FAIL', label: 'Refuse everything (to see failures)' }] },
    { key: 'capacity', label: 'Visits per slot', kind: 'number', min: 1, max: 100 },
  ],
  defaults: () => ({ mode: 'OK', capacity: 2 }),
  validate(raw) {
    const r = (raw ?? {}) as { mode?: string; capacity?: number };
    const mode = r.mode ?? 'OK', capacity = r.capacity ?? 2;
    if (!['OK', 'ASYNC', 'FAIL'].includes(mode)) throw invalid('The simulator confirms at once, confirms later, or refuses.');
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 100) throw invalid('Visits per slot is a whole number from 1 to 100.');
    return { mode, capacity };
  },
  create(config): WfmConnector {
    const fail = config.mode === 'FAIL', capacity = Number(config.capacity ?? 2);
    const refuse = () => ({ ok: false as const, retryable: true, detail: 'Simulator is set to refuse everything.' });
    return {
      vendor: 'simulator',
      problem: () => null,
      async availability(q) {
        if (fail) return refuse();
        const slots: WfmSlot[] = [];
        const start = Date.parse(q.from), end = Date.parse(q.to);
        for (let t = Math.floor(start / DAY) * DAY; t <= end && slots.length < 200; t += DAY) {
          const dow = new Date(t).getUTCDay();
          if (dow === 0 || dow === 6) continue;
          for (const [a, b] of WINDOWS) {
            const s = t + a * HOUR, e = t + b * HOUR;
            if (s < start || s > end || (b - a) * 60 < q.durationMinutes) continue;
            const id = `sim:${new Date(s).toISOString()}`;
            const left = capacity - (q.booked[new Date(s).toISOString()] ?? 0);
            if (left > 0) slots.push({ id, start: new Date(s).toISOString(), end: new Date(e).toISOString(), capacityLeft: left });
          }
        }
        return { ok: true, slots };
      },
      async reserve(b) { return fail ? refuse() : { ok: true, reservationRef: `SIM-R-${b.idempotencyKey.slice(-10)}`, expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() }; },
      async confirm(b) {
        if (fail) return refuse();
        const jobRef = `SIM-JOB-${b.idempotencyKey.slice(-10)}`;
        return config.mode === 'ASYNC' ? { ok: true, jobRef, status: 'REQUESTED' } : { ok: true, jobRef, status: 'SCHEDULED', technician: { ref: 'SIM-T1', name: 'Sim Technician' } };
      },
      async cancel() { return fail ? refuse() : { ok: true }; },
      async test() { return { ok: !fail, detail: fail ? 'The simulator is set to refuse.' : 'The simulator is always reachable.' }; },
    };
  },
};
