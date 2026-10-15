import { Body, Controller, Get, Inject, Param, Post } from '@nestjs/common';
import type { Client } from '@temporalio/client';
import { approveSignal, billRunGovernanceWorkflow, cancelSignal, excludeSignal, governanceStatus, includeSignal, rejectSignal, retrySignal, submitSignal, type BillRunGovernanceInput } from '../workflows/bill-run-governance.workflow.js';
import { TASK_QUEUE, TEMPORAL } from './orders.controller.js';

/** Starts a governed bill run as a durable workflow and carries people's decisions to it as signals. The CRM does the same work in its own screens; this is for a deployment that wants durable deadlines. */
@Controller('meridian-api/bill-runs')
export class BillRunController {
  constructor(@Inject(TEMPORAL) private readonly temporal: Client) {}

  @Post()
  async start(@Body() b: BillRunGovernanceInput) {
    const key = b.request.cycleDay ? `cycle-${b.request.cycleDay}-${b.request.asOf ?? 'next'}` : b.request.daily ? `daily-${b.request.asOf ?? 'today'}` : `selective-${Date.now()}`;
    const h = await this.temporal.workflow.start(billRunGovernanceWorkflow, { taskQueue: TASK_QUEUE, workflowId: `bill-run-${key}`, args: [b] }); // one workflow per cycle and date
    return { workflowId: h.workflowId, runId: h.firstExecutionRunId };
  }
  @Post(':id/exclude') async exclude(@Param('id') id: string, @Body() b: { accountId?: string; customerId?: string; reason: string; by: string }) { await this.h(id).signal(excludeSignal, b); return { ok: true }; }
  @Post(':id/include') async include(@Param('id') id: string, @Body() b: { accountIds: string[]; by: string }) { await this.h(id).signal(includeSignal, b); return { ok: true }; }
  @Post(':id/submit') async submit(@Param('id') id: string, @Body() b: { by: string; note?: string }) { await this.h(id).signal(submitSignal, b); return { ok: true }; }
  @Post(':id/approve') async approve(@Param('id') id: string, @Body() b: { by: string; note?: string }) { await this.h(id).signal(approveSignal, b); return { ok: true }; }
  @Post(':id/reject') async reject(@Param('id') id: string, @Body() b: { by: string; note: string }) { await this.h(id).signal(rejectSignal, b); return { ok: true }; }
  @Post(':id/cancel') async cancel(@Param('id') id: string, @Body() b: { by: string; note?: string }) { await this.h(id).signal(cancelSignal, b); return { ok: true }; }
  @Post(':id/retry') async retry(@Param('id') id: string, @Body() b: { by: string }) { await this.h(id).signal(retrySignal, b); return { ok: true }; }
  @Get(':id') status(@Param('id') id: string) { return this.h(id).query(governanceStatus); }
  private h(id: string) { return this.temporal.workflow.getHandle(id); }
}
