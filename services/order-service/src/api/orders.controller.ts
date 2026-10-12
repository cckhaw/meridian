import { BadRequestException, Body, Controller, Get, Inject, Param, Post } from '@nestjs/common';
import type { Client } from '@temporalio/client';
import type { Order, OrderWorkflowDefinition } from '@nexus/types';
import { fiberFlow, retailDeviceFlow } from '../graph/default-definitions.js';
import { validateDefinition } from '../graph/validate.js';
import type { Facts } from '../graph/walk.js';
import { cancelRequested, installationScheduled, orderStatus, orderWorkflow, paymentConfirmed } from '../workflows/order.workflow.js';

export const TEMPORAL = Symbol('TEMPORAL');
export const TASK_QUEUE = 'nexus-orders';

/** In-memory registry until the designer persists definitions (see docs/roadmap). */
const definitions = new Map<string, OrderWorkflowDefinition>([[retailDeviceFlow.id, retailDeviceFlow], [fiberFlow.id, fiberFlow]]);

/** TM Forum TMF622 Product Ordering (subset) + rule-designer endpoints. */
@Controller('tmf-api/productOrderingManagement/v5')
export class OrdersController {
  constructor(@Inject(TEMPORAL) private readonly temporal: Client) {}

  @Get('workflowDefinition')
  listDefinitions() { return [...definitions.values()]; }

  @Post('workflowDefinition/validate')
  validate(@Body() def: OrderWorkflowDefinition) { return { errors: validateDefinition(def) }; }

  @Post('workflowDefinition')
  saveDefinition(@Body() def: OrderWorkflowDefinition) {
    const errors = validateDefinition(def);
    if (errors.length) throw new BadRequestException({ message: 'invalid workflow', errors });
    definitions.set(def.id, def);
    return def;
  }

  @Post('productOrder')
  async create(@Body() body: { order: Pick<Order, 'id'>; definitionId: string; facts: Facts }) {
    const definition = definitions.get(body.definitionId);
    if (!definition) throw new BadRequestException(`unknown definition ${body.definitionId}`);
    const handle = await this.temporal.workflow.start(orderWorkflow, {
      taskQueue: TASK_QUEUE,
      workflowId: `order-${body.order.id}`, // idempotent: duplicate submit fails fast
      args: [{ orderId: body.order.id, definition, facts: body.facts }],
    });
    return { workflowId: handle.workflowId, runId: handle.firstExecutionRunId };
  }

  @Get('productOrder/:id')
  status(@Param('id') id: string) {
    return this.temporal.workflow.getHandle(`order-${id}`).query(orderStatus);
  }

  @Post('productOrder/:id/cancel')
  async cancel(@Param('id') id: string, @Body() b: { reason: string }) {
    const h = this.temporal.workflow.getHandle(`order-${id}`);
    await h.signal(cancelRequested, b);
    return h.query(orderStatus); // client sees cancelRejected immediately if PNR passed
  }

  @Post('productOrder/:id/payment') payment(@Param('id') id: string, @Body() b: { reference: string }) { return this.temporal.workflow.getHandle(`order-${id}`).signal(paymentConfirmed, b); }
  @Post('productOrder/:id/installation') install(@Param('id') id: string, @Body() b: { slot: string }) { return this.temporal.workflow.getHandle(`order-${id}`).signal(installationScheduled, b); }
}
