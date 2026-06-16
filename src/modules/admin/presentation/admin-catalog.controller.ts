import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AdminGuard } from '../../../common/guards/admin.guard';
import { PermissionGuard } from '../../../common/guards/permission.guard';
import { Permissions } from '../../../common/decorators/permissions.decorator';
import { AdminService } from '../admin.service';
import { CreateCategoryDto } from '../application/dto/create-category.dto';
import { CreateProductDto } from '../application/dto/create-product.dto';
import { CreatePromoDto } from '../application/dto/create-promo.dto';
import { UpdateCategoryDto } from '../application/dto/update-category.dto';
import { UpdateProductDto } from '../application/dto/update-product.dto';
import { UpdatePromoDto } from '../application/dto/update-promo.dto';

@ApiTags('admin-catalog')
@UseGuards(AdminGuard, PermissionGuard)
@Controller({ path: 'admin/catalog', version: '1' })
export class AdminCatalogController {
  constructor(private readonly adminService: AdminService) {}

  @Permissions('Product.create')
  @Post('products')
  createProduct(@Body() dto: CreateProductDto) {
    return this.adminService.createProduct(dto);
  }

  @Permissions('Product.read')
  @Get('products')
  listProducts() {
    return this.adminService.listProducts();
  }

  @Permissions('Product.read')
  @Get('products/:id')
  getProduct(@Param('id') id: string) {
    return this.adminService.getProduct(id);
  }

  @Permissions('Product.update')
  @Patch('products/:id')
  updateProduct(@Param('id') id: string, @Body() dto: UpdateProductDto) {
    return this.adminService.updateProduct(id, dto);
  }

  @Permissions('Product.delete')
  @Delete('products/:id')
  deleteProduct(@Param('id') id: string) {
    return this.adminService.deleteProduct(id);
  }

  @Permissions('Category.create')
  @Post('categories')
  createCategory(@Body() dto: CreateCategoryDto) {
    return this.adminService.createCategory(dto);
  }

  @Permissions('Category.read')
  @Get('categories')
  listCategories() {
    return this.adminService.listCategories();
  }

  @Permissions('Category.read')
  @Get('categories/:id')
  getCategory(@Param('id') id: string) {
    return this.adminService.getCategory(id);
  }

  @Permissions('Category.update')
  @Patch('categories/:id')
  updateCategory(@Param('id') id: string, @Body() dto: UpdateCategoryDto) {
    return this.adminService.updateCategory(id, dto);
  }

  @Permissions('Category.delete')
  @Delete('categories/:id')
  deleteCategory(@Param('id') id: string) {
    return this.adminService.deleteCategory(id);
  }

  @Permissions('Promo.create')
  @Post('promos')
  createPromo(@Body() dto: CreatePromoDto) {
    return this.adminService.createPromo(dto);
  }

  @Permissions('Promo.read')
  @Get('promos')
  listPromos() {
    return this.adminService.listPromos();
  }

  @Permissions('Promo.read')
  @Get('promos/:id')
  getPromo(@Param('id') id: string) {
    return this.adminService.getPromo(id);
  }

  @Permissions('Promo.update')
  @Patch('promos/:id')
  updatePromo(@Param('id') id: string, @Body() dto: UpdatePromoDto) {
    return this.adminService.updatePromo(id, dto);
  }

  @Permissions('Promo.delete')
  @Delete('promos/:id')
  deletePromo(@Param('id') id: string) {
    return this.adminService.deletePromo(id);
  }
}
