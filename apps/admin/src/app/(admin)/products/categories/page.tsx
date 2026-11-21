'use client';

import { TaxonomyManager } from '@/components/taxonomy/taxonomy-manager';

export default function ProductCategoriesPage() {
  return (
    <TaxonomyManager
      endpoint="/admin/products/categories"
      queryKey="product-categories"
      title="Danh mục sản phẩm"
      description="Phân loại sản phẩm theo cây danh mục nhiều cấp"
      singular="danh mục"
      breadcrumbs={[{ label: 'Sản phẩm', href: '/products' }, { label: 'Danh mục' }]}
      hasParent
      hasImage
      hasActive
      hasDescription
      hasSeo
      routePrefix="product_category"
      countKey="products"
      countLabel="Sản phẩm"
      customFieldsEntity="product_category"
      permission="products.taxonomy"
    />
  );
}
