import { invalid } from '../errors.js';
import { genericRestVendor } from './generic-rest.js';
import { simulatorVendor } from './simulator.js';
import type { OcsVendor } from './types.js';

export * from './types.js';
export { GENERIC_REST_EXAMPLE, TEMPLATE_VARS, createGenericRestConnector, render, validateGenericRest, varsOf } from './generic-rest.js';

/**
 * Every charging system Meridian can talk to. To add a vendor: write one file in this folder that exports an `OcsVendor` (its settings, how to check them, and
 * a connector that turns an `OcsRequest` into that vendor's calls), and add it here. Nothing else in Meridian changes.
 */
export const OCS_VENDORS: Record<string, OcsVendor> = {
  [genericRestVendor.id]: genericRestVendor,
  [simulatorVendor.id]: simulatorVendor,
};
export const ocsVendor = (id: string): OcsVendor => { const v = OCS_VENDORS[id]; if (!v) throw invalid(`unknown OCS vendor ${id}`); return v; };
