import { Body, Controller, Get, Inject, Param, Post } from '@nestjs/common';
import type { Client } from '@temporalio/client';
import type { DunningStepInput } from '../activities/dunning.js';
import { dunningStatus, dunningWorkflow, paymentReceivedSignal } from '../workflows/dunning.workflow.js';
import { TASK_QUEUE, TEMPORAL } from './orders.controller.js';

/** Starts and signals dunning ladders. The CRM starts one when an account first has an overdue invoice and signals it when a payment settles. */
@Controller('meridian-api/dunning')
export class DunningController {
  constructor(@Inject(TEMPORAL) private readonly temporal: Client) {}

  @Post('accounts/:id')
  async start(@Param('id') accountId: string, @Body() b: { dueDate: string; steps: DunningStepInput[] }) {
    const handle = await this.temporal.workflow.start(dunningWorkflow, {
      taskQueue: TASK_QUEUE,
      workflowId: `dunning-${accountId}`, // one ladder per account: a second start fails fast
      args: [{ accountId, dueDate: b.dueDate, steps: b.steps }],
    });
    return { workflowId: handle.workflowId, runId: handle.firstExecutionRunId };
  }

  /** The payment webhook. Harmless if the ladder has already ended. */
  @Post('accounts/:id/payment')
  async paid(@Param('id') accountId: string, @Body() b: { invoiceId?: string; amountMinor?: number }) {
    await this.temporal.workflow.getHandle(`dunning-${accountId}`).signal(paymentReceivedSignal, b);
    return { ok: true };
  }

  @Get('accounts/:id')
  status(@Param('id') accountId: string) { return this.temporal.workflow.getHandle(`dunning-${accountId}`).query(dunningStatus); }
}
