import { ListProductsQueryDto } from '../application/dto/catalog.dto';

export interface CatalogRepository {
  listProducts(query: ListProductsQueryDto): Promise<unknown[]>;
  getProduct(idOrSlug: string): Promise<unknown>;
  listCategories(): Promise<unknown[]>;
  listToppings(): Promise<unknown[]>;
  listPromos(): Promise<unknown[]>;
}

export const CATALOG_REPOSITORY = Symbol('CATALOG_REPOSITORY');
