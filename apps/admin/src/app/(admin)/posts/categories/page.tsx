'use client';

import { TaxonomyManager } from '@/components/taxonomy/taxonomy-manager';

export default function PostCategoriesPage() {
  return (
    <TaxonomyManager
      endpoint="/admin/posts/categories"
      queryKey="post-categories"
      title="Chuyên mục bài viết"
      description="Tổ chức bài viết theo chuyên mục nhiều cấp"
      singular="chuyên mục"
      breadcrumbs={[{ label: 'Bài viết', href: '/posts' }, { label: 'Chuyên mục' }]}
      hasParent
      hasImage
      hasDescription
      hasSeo
      routePrefix="post_category"
      countKey="posts"
      countLabel="Bài viết"
      customFieldsEntity="post_category"
      permission="posts.taxonomy"
    />
  );
}
