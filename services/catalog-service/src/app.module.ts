import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { CatalogController } from './catalog/catalog.controller.js';
import { CatalogNodeDoc, CatalogNodeSchema } from './catalog/catalog.schema.js';
import { CatalogService } from './catalog/catalog.service.js';

@Module({
  imports: [
    MongooseModule.forRoot(process.env.MONGO_URL ?? 'mongodb://localhost:27017/nexus_catalog'),
    MongooseModule.forFeature([{ name: CatalogNodeDoc.name, schema: CatalogNodeSchema }]),
  ],
  controllers: [CatalogController],
  providers: [CatalogService],
})
export class AppModule {}
