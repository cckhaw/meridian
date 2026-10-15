import { invalid } from '../errors.js';
import { wfmRestVendor } from './rest.js';
import { wfmSimulatorVendor } from './simulator.js';
import type { WfmVendor } from './types.js';

export * from './types.js';
export { createWfmRestConnector } from './rest.js';

/** Every field-service system Meridian can talk to. To add one: a file here that exports a `WfmVendor`, and a line below. */
export const WFM_VENDORS: Record<string, WfmVendor> = { [wfmRestVendor.id]: wfmRestVendor, [wfmSimulatorVendor.id]: wfmSimulatorVendor };
export const wfmVendor = (id: string): WfmVendor => { const v = WFM_VENDORS[id]; if (!v) throw invalid(`unknown field-service vendor ${id}`); return v; };
