import type { Db } from '@meridian/core';
import { qualifyAddress, type QualifyInput } from './serviceability.js';
import { confirmReservation, releaseReservation, reservePort, sweepExpiredLocks, activateReservation, type ReserveInput } from './reservations.js';
import { exhaustionReport, joinWaitlist, notifyWaitlist, type WaitlistInput } from './dashboard.js';
import { importCoverage, type ImportInput } from './import.js';
import { moduleEnabled, setModuleEnabled } from './settings.js';
import { Tmf645Adapter } from './tmf645-adapter.js';

/**
 * The coverage engine as one object, the shape the NestJS service in the original brief had: spatial lookups, multi-partner aggregation and port locks. The route
 * handlers of apps/fiber-coverage call this and nothing else; the work is in the modules it delegates to.
 */
export class CoverageService {
  constructor(private db: Db) {}
  enabled() { return moduleEnabled(this.db); }
  setEnabled(actor: string, on: boolean) { return setModuleEnabled(this.db, actor, on); }
  qualify(i: QualifyInput) { return qualifyAddress(this.db, i); }
  reserve(i: ReserveInput) { return reservePort(this.db, i); }
  confirm(id: string, orderRef: string, actor?: string) { return confirmReservation(this.db, id, orderRef, actor); }
  release(id: string, actor?: string) { return releaseReservation(this.db, id, actor); }
  activate(id: string, actor?: string) { return activateReservation(this.db, id, actor); }
  sweep() { return sweepExpiredLocks(this.db); }
  waitlist(i: WaitlistInput) { return joinWaitlist(this.db, i); }
  notify(dpId: string, actor: string) { return notifyWaitlist(this.db, dpId, actor); }
  pressure() { return exhaustionReport(this.db); }
  import(i: ImportInput) { return importCoverage(this.db, i); }
  tmf(origin: string) { return new Tmf645Adapter(this.db, origin); }
}
