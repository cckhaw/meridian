import { NativeConnection, Worker } from '@temporalio/worker';
import { stubActivities } from './activities/index.js';
import { stubDunningActivities } from './activities/dunning.js';
import { stubNrmActivities } from './activities/nrm.js';
import { TASK_QUEUE } from './api/orders.controller.js';

const connection = await NativeConnection.connect({ address: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233' });
const worker = await Worker.create({
  connection,
  taskQueue: TASK_QUEUE,
  workflowsPath: new URL('./workflows/index.ts', import.meta.url).pathname,
  activities: { ...stubActivities, ...stubDunningActivities, ...stubNrmActivities } as unknown as Record<string, (...a: never[]) => unknown>,
});
await worker.run();
