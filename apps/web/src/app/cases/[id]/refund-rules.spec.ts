import { describe, expect, it } from 'vitest';
import { canWithdrawRefund } from './refund-rules';

describe('canWithdrawRefund', () => {
  const req = { requestedBy: 'amy' };
  it('lets the requester and a super user withdraw', () => {
    expect(canWithdrawRefund({ username: 'amy', isSuperuser: false }, req)).toBe(true);
    expect(canWithdrawRefund({ username: 'root', isSuperuser: true }, req)).toBe(true);
  });
  it('refuses everyone else, including a similar username', () => {
    expect(canWithdrawRefund({ username: 'bob', isSuperuser: false }, req)).toBe(false);
    expect(canWithdrawRefund({ username: 'Amy', isSuperuser: false }, req)).toBe(false);
    expect(canWithdrawRefund(null, req)).toBe(false);
  });
});
