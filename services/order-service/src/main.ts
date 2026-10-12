import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Client, Connection } from '@temporalio/client';
import { OrdersController, TEMPORAL } from './api/orders.controller.js';

@Module({
  controllers: [OrdersController],
  providers: [{
    provide: TEMPORAL,
    useFactory: async () => new Client({ connection: await Connection.connect({ address: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233' }) }),
  }],
})
class AppModule {}

const app = await NestFactory.create(AppModule);
app.enableCors();
await app.listen(Number(process.env.PORT ?? 4002));
