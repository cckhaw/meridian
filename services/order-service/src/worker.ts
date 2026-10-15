import { NativeConnection, Worker } from '@temporalio/worker';
import { stubActivities } from './activities/index.js';
import { stubBillRunActivities } from './activities/bill-run.js';
import { stubCaseSlaActivities } from './activities/case-sla.js';
import { stubDunningActivities } from './activities/dunning.js';
import { stubNrmActivities } from './activities/nrm.js';
import { stubPortInActivities } from './activities/port-in.js';
import { TASK_QUEUE } from './api/orders.controller.js';

const connection = await NativeConnection.connect({ address: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233' });
const worker = await Worker.create({
  connection,
  taskQueue: TASK_QUEUE,
  workflowsPath: new URL('./workflows/index.ts', import.meta.url).pathname,
  activities: { ...stubActivities, ...stubDunningActivities, ...stubBillRunActivities(), ...stubCaseSlaActivities, ...stubNrmActivities, ...stubPortInActivities } as unknown as Record<string, (...a: never[]) => unknown>,
});
await worker.run();
