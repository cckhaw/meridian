import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import type { CatalogNode } from '@nexus/types';
import { CatalogService } from './catalog.service.js';

/** TM Forum TMF620 Product Catalog Management — base path /tmf-api/productCatalogManagement/v5. */
@Controller('tmf-api/productCatalogManagement/v5')
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Get('productOffering')
  list(@Query('path') path = '', @Query('status') status?: string) {
    return this.catalog.subtree(path, status);
  }

  @Get('productOffering/:id')
  get(@Param('id') id: string) {
    return this.catalog.get(id);
  }

  @Post('productOffering')
  create(@Body() body: Omit<CatalogNode, 'id' | 'createdAt' | 'updatedAt' | 'version'>) {
    return this.catalog.create(body);
  }

  @Patch('productOffering/:id/activate')
  activate(@Param('id') id: string) {
    return this.catalog.activate(id);
  }

  /** Non-TMF extension: quote ETC for a contract at a given termination date. */
  @Get('productOffering/:id/etcQuote')
  etc(@Param('id') id: string, @Query('contractStart') start: string, @Query('terminationDate') end = new Date().toISOString()) {
    return this.catalog.etcQuote(id, new Date(start), new Date(end));
  }
}
