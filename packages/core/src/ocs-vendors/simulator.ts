import { invalid } from '../errors.js';
import type { OcsConnector, OcsVendor } from './types.js';

/** A pretend OCS for development and demos: accepts everything (or refuses everything, to see how failures look). Never talks to anything. */
export const simulatorVendor: OcsVendor = {
  id: 'simulator',
  label: 'Simulator (no real system)',
  summary: 'Accepts every command and gives back a made-up reference. Use it to see the flow end to end before a real connector is connected.',
  real: false,
  fields: [{ key: 'mode', label: 'Behaviour', kind: 'select', options: [{ value: 'OK', label: 'Accept everything' }, { value: 'FAIL', label: 'Refuse everything (to see retries and failures)' }] }],
  defaults: () => ({ mode: 'OK' }),
  validate(raw) {
    const mode = (raw as { mode?: string } | null)?.mode ?? 'OK';
    if (mode !== 'OK' && mode !== 'FAIL') throw invalid('The simulator either accepts or refuses.');
    return { mode };
  },
  create(config): OcsConnector {
    return {
      vendor: 'simulator',
      problem: () => null,
      async handle(req) {
        if (config.mode === 'FAIL') return { ok: false, retryable: true, detail: 'Simulator is set to refuse everything.' };
        return { ok: true, reference: `SIM-${req.command}-${req.idempotencyKey.slice(-8)}`, detail: 'Accepted by the simulator.' };
      },
      async test() { return { ok: config.mode !== 'FAIL', detail: config.mode === 'FAIL' ? 'The simulator is set to refuse.' : 'The simulator is always reachable.' }; },
    };
  },
};
