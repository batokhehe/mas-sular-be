import { Module } from '@nestjs/common';
import { CATALOG_REPOSITORY } from './domain/catalog.repository';
import { PrismaCatalogRepository } from './infrastructure/prisma-catalog.repository';
import { CatalogController } from './presentation/catalog.controller';

@Module({
  controllers: [CatalogController],
  providers: [{ provide: CATALOG_REPOSITORY, useClass: PrismaCatalogRepository }],
  exports: [CATALOG_REPOSITORY],
})
export class CatalogModule {}
