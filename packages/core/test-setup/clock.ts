/**
 * Bill cycles run on days 1 to 28 only (the database refuses 29 to 31), and plenty of specs bill "today". On the 29th, 30th and 31st the real date would make them
 * fail for a reason that has nothing to do with the code, so on those days the clock is moved back to the 28th of the same month (same month and year, so the
 * monthly ledger partitions still match). It is a constant shift, not a frozen or stepped clock: time still passes at full resolution, so ordering by timestamp
 * and time budgets behave as they do for real. On every other day the real clock is used untouched.
 */
const RealDate = Date;
const real = new RealDate();
if (real.getUTCDate() > 28) {
  const target = RealDate.UTC(real.getUTCFullYear(), real.getUTCMonth(), 28, real.getUTCHours(), real.getUTCMinutes(), real.getUTCSeconds(), real.getUTCMilliseconds());
  const shift = target - real.getTime();
  class ShiftedDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(RealDate.now() + shift);
      else super(...(args as [number]));
    }
    static override now() { return RealDate.now() + shift; }
  }
  globalThis.Date = ShiftedDate as unknown as DateConstructor;
}
