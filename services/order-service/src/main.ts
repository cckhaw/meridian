import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Client, Connection } from '@temporalio/client';
import { BillRunController } from './api/bill-run.controller.js';
import { DunningController } from './api/dunning.controller.js';
import { NrmController } from './api/nrm.controller.js';
import { PortInController } from './api/port-in.controller.js';
import { OrdersController, TEMPORAL } from './api/orders.controller.js';

@Module({
  controllers: [OrdersController, DunningController, BillRunController, NrmController, PortInController],
  providers: [{
    provide: TEMPORAL,
    useFactory: async () => new Client({ connection: await Connection.connect({ address: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233' }) }),
  }],
})
class AppModule {}

const app = await NestFactory.create(AppModule);
app.enableCors();
await app.listen(Number(process.env.PORT ?? 4002));
