import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

const app = await NestFactory.create(AppModule);
app.enableCors();
await app.listen(Number(process.env.PORT ?? 4001));
