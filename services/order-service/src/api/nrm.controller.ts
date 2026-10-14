import { Body, Controller, Get, Inject, Post } from '@nestjs/common';
import type { Client } from '@temporalio/client';
import { imsiRecycleWorkflow, recycleNowSignal, recycleStatus } from '../workflows/imsi-recycle.workflow.js';
import { TASK_QUEUE, TEMPORAL } from './orders.controller.js';

const WORKFLOW_ID = 'nrm-recycle';

/** Starts the number-resource recycling clock (one instance), triggers a sweep on demand, and reports what it has restored. */
@Controller('meridian-api/nrm')
export class NrmController {
  constructor(@Inject(TEMPORAL) private readonly temporal: Client) {}

  @Post('recycle/start')
  async start(@Body() b: { everyMinutes?: number }) {
    const handle = await this.temporal.workflow.start(imsiRecycleWorkflow, { taskQueue: TASK_QUEUE, workflowId: WORKFLOW_ID, args: [{ everyMinutes: b?.everyMinutes }] });
    return { workflowId: handle.workflowId, runId: handle.firstExecutionRunId };
  }

  @Post('recycle/now')
  async now() { await this.temporal.workflow.getHandle(WORKFLOW_ID).signal(recycleNowSignal); return { ok: true }; }

  @Get('recycle')
  status() { return this.temporal.workflow.getHandle(WORKFLOW_ID).query(recycleStatus); }
}
