import { describe, expect, it } from 'vitest';
import { duplicateProblem, emptyPortIn, isExclusive, lineBody, newItem, newMember, takenElsewhere, type Item } from './wizard-types';

const plan = (id: string, kind = 'SIM_ONLY') => ({ id, name: id, kind, prices: [], group: undefined });
const item = (o: Partial<Item> = {}): Item => ({ ...newItem(plan('p')), ...o });

describe('order wizard helpers', () => {
  it('does not send a port-in that is still being filled in, so the quote is not refused', () => {
    const half = item({ portIn: emptyPortIn() });
    expect(lineBody(half).portIn).toBeUndefined();
    const done = item({ portIn: { ...emptyPortIn(), donorOperatorId: 'op', donorMsisdn: '60198889999', holderName: 'A', holderIdNumber: '1' } });
    expect(lineBody(done).portIn).toMatchObject({ donorMsisdn: '60198889999' });
  });

  it('finds a SIM card or number chosen for two lines, members included', () => {
    const a = item({ iccid: '8960000000000000001', msisdn: '' });
    const m1 = { ...newMember('m'), iccid: '8960000000000000002' }, m2 = { ...newMember('m'), iccid: '8960000000000000001' };
    expect(duplicateProblem([{ ...a, members: [m1] }])).toBeNull();
    expect(duplicateProblem([{ ...a, members: [m1, m2] }])).toMatch(/SIM card 8960000000000000001/);
    const n1 = { ...newMember('m'), msisdn: '+60125000001' }, n2 = { ...newMember('m'), portIn: { ...emptyPortIn(), donorMsisdn: '60125000001' } };
    expect(duplicateProblem([{ ...a, members: [n1, n2] }])).toMatch(/number 60125000001/);
  });

  it('tells a picker which cards and numbers the other lines already hold', () => {
    const m1 = { ...newMember('m'), iccid: '8960000000000000002', msisdn: '+60125000002' };
    const head = item({ iccid: '8960000000000000001', members: [m1] });
    const forMember = takenElsewhere([head], m1);
    expect([...forMember.iccids]).toEqual(['8960000000000000001']);
    expect(forMember.msisdns.has('60125000002')).toBe(false);
    expect(takenElsewhere([head], head).iccids.has('8960000000000000002')).toBe(true);
  });

  it('counts only mobile plans toward the one-plan rule', () => {
    expect(isExclusive(plan('a'))).toBe(true);
    expect(isExclusive(plan('a', 'SIM_DEVICE'))).toBe(true);
    expect(isExclusive(plan('a', 'VAS'))).toBe(false);
    expect(isExclusive(plan('a', 'NON_TELCO_SUBSCRIPTION'))).toBe(false);
    expect(isExclusive(plan('a', 'PHYSICAL_GOOD'))).toBe(false);
    expect(isExclusive(plan('a', 'FIBER'))).toBe(false);
  });
});
