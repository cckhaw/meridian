import { Body, Controller, Get, Inject, Param, Post } from '@nestjs/common';
import type { Client } from '@temporalio/client';
import type { PortDecision, PortInDetails } from '../activities/port-in.js';
import { portDecisionSignal, portInStatus, portInWorkflow } from '../workflows/port-in.workflow.js';
import { TASK_QUEUE, TEMPORAL } from './orders.controller.js';

const idOf = (portInId: string) => `port-in-${portInId}`;

/** Starts the durable port-in process for a request the CRM raised, receives the clearinghouse's callback, and reports where it stands. */
@Controller('meridian-api/port-in')
export class PortInController {
  constructor(@Inject(TEMPORAL) private readonly temporal: Client) {}

  @Post('start')
  async start(@Body() b: PortInDetails & { expiryDays?: number }) {
    const handle = await this.temporal.workflow.start(portInWorkflow, { taskQueue: TASK_QUEUE, workflowId: idOf(b.portInId), args: [b] });
    return { workflowId: handle.workflowId, runId: handle.firstExecutionRunId };
  }

  /** The MNP callback. Repeating it is harmless: the workflow keeps the first answer. */
  @Post(':portInId/decision')
  async decision(@Param('portInId') portInId: string, @Body() d: PortDecision) {
    await this.temporal.workflow.getHandle(idOf(portInId)).signal(portDecisionSignal, d);
    return { ok: true };
  }

  @Get(':portInId')
  status(@Param('portInId') portInId: string) { return this.temporal.workflow.getHandle(idOf(portInId)).query(portInStatus); }
}
