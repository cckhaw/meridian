/** Same rule as the server's `cancelRefund`: only the person who asked for the refund, or a super user, can withdraw it. */
export const canWithdrawRefund = (me: { username: string; isSuperuser: boolean } | null | undefined, request: { requestedBy: string }): boolean =>
  !!me && (request.requestedBy === me.username || me.isSuperuser);

export const WITHDRAW_BLOCKED = 'Only the person who asked for the refund, or a super user, can withdraw it.';
