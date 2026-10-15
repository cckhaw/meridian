import { Body, Controller, Get, Inject, Param, Post } from '@nestjs/common';
import type { Client } from '@temporalio/client';
import { WorkflowExecutionAlreadyStartedError } from '@temporalio/client';
import { caseChangedSignal, caseSlaStatus, caseSlaWorkflow, dispatchUpdatedSignal } from '../workflows/case-sla.workflow.js';
import { TASK_QUEUE, TEMPORAL } from './orders.controller.js';

/** Starts a case's SLA watchdog when the case opens and tells it when the case changes. */
@Controller('meridian-api/cases')
export class CaseSlaController {
  constructor(@Inject(TEMPORAL) private readonly temporal: Client) {}

  @Post(':id/sla')
  async start(@Param('id') caseId: string) {
    try {
      const h = await this.temporal.workflow.start(caseSlaWorkflow, { taskQueue: TASK_QUEUE, workflowId: `case-sla-${caseId}`, args: [{ caseId }] });   // one watchdog per case
      return { workflowId: h.workflowId, runId: h.firstExecutionRunId, started: true };
    } catch (e) {
      if (e instanceof WorkflowExecutionAlreadyStartedError) return { workflowId: `case-sla-${caseId}`, started: false };   // already watching: starting twice is harmless
      throw e;
    }
  }
  @Post(':id/changed') async changed(@Param('id') caseId: string) { await this.temporal.workflow.getHandle(`case-sla-${caseId}`).signal(caseChangedSignal); return { ok: true }; }
  /** Called when the field-service system reports on the case's visit: wakes the watchdog to look at the case again. */
  @Post(':id/dispatch-updated') async dispatchUpdated(@Param('id') caseId: string, @Body() b: { event?: string }) { await this.temporal.workflow.getHandle(`case-sla-${caseId}`).signal(dispatchUpdatedSignal, b); return { ok: true }; }
  @Get(':id/sla') status(@Param('id') caseId: string) { return this.temporal.workflow.getHandle(`case-sla-${caseId}`).query(caseSlaStatus); }
}
