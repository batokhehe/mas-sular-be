import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ListProductsQueryDto } from '../application/dto/catalog.dto';
import { CATALOG_REPOSITORY, CatalogRepository } from '../domain/catalog.repository';

@ApiTags('catalog')
@Controller({ path: 'catalog', version: '1' })
export class CatalogController {
  constructor(@Inject(CATALOG_REPOSITORY) private readonly catalog: CatalogRepository) {}

  @Get('products')
  listProducts(@Query() query: ListProductsQueryDto) {
    return this.catalog.listProducts(query);
  }

  @Get('products/:idOrSlug')
  getProduct(@Param('idOrSlug') idOrSlug: string) {
    return this.catalog.getProduct(idOrSlug);
  }

  @Get('categories')
  listCategories() {
    return this.catalog.listCategories();
  }

  @Get('toppings')
  listToppings() {
    return this.catalog.listToppings();
  }

  @Get('promos')
  listPromos() {
    return this.catalog.listPromos();
  }
}
