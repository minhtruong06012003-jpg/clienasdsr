import { Module } from '@nestjs/common';
import { ProductsController, PublicProductsController } from './products.controller.js';
import { ProductsService } from './products.service.js';
import { ProductCategoriesService } from './product-categories.service.js';
import { ProductsCsvService } from './products-csv.service.js';
import { ProductAttributesController, PublicProductAttributesController } from './attributes.controller.js';
import { ProductAttributesService } from './attributes.service.js';

@Module({
  controllers: [ProductsController, PublicProductsController, ProductAttributesController, PublicProductAttributesController],
  providers: [ProductsService, ProductCategoriesService, ProductsCsvService, ProductAttributesService],
  exports: [ProductsService, ProductCategoriesService, ProductAttributesService],
})
export class ProductsModule {}
