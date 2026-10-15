import { Body, Controller, Get, Inject, Param, Post } from '@nestjs/common';
import type { Client } from '@temporalio/client';
import { dunningLadderWorkflow, ladderStatus, partialPaymentSignal, paymentReceivedSignal } from '../workflows/dunning-ladder.workflow.js';
import { TASK_QUEUE, TEMPORAL } from './orders.controller.js';

/** Starts and signals rule-driven dunning ladders (Settings → Dunning rules). The CRM starts one when an account first has an overdue invoice and signals it when a payment lands. */
@Controller('meridian-api/dunning-ladder')
export class DunningLadderController {
  constructor(@Inject(TEMPORAL) private readonly temporal: Client) {}

  @Post('accounts/:id')
  async start(@Param('id') accountId: string, @Body() b: { recheckHours?: number } = {}) {
    const handle = await this.temporal.workflow.start(dunningLadderWorkflow, {
      taskQueue: TASK_QUEUE,
      workflowId: `dunning-ladder-${accountId}`, // one ladder per account: a second start fails fast
      args: [{ accountId, recheckHours: b?.recheckHours }],
    });
    return { workflowId: handle.workflowId, runId: handle.firstExecutionRunId };
  }

  /** A payment that clears everything overdue (a bank webhook, a QR scan, cash at a store). Harmless if the ladder has ended. */
  @Post('accounts/:id/payment')
  async paid(@Param('id') accountId: string, @Body() b: { invoiceId?: string; amountMinor?: number }) {
    await this.temporal.workflow.getHandle(`dunning-ladder-${accountId}`).signal(paymentReceivedSignal, b ?? {});
    return { ok: true };
  }

  /** A payment that leaves something overdue: the ladder reads the CRM again (the rule's partial-payment policy has already been applied there). */
  @Post('accounts/:id/partial')
  async partial(@Param('id') accountId: string, @Body() b: { amountMinor?: number; pausedUntil?: string }) {
    await this.temporal.workflow.getHandle(`dunning-ladder-${accountId}`).signal(partialPaymentSignal, b ?? {});
    return { ok: true };
  }

  @Get('accounts/:id')
  status(@Param('id') accountId: string) { return this.temporal.workflow.getHandle(`dunning-ladder-${accountId}`).query(ladderStatus); }
}
