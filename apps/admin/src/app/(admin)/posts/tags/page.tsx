'use client';

import { TaxonomyManager } from '@/components/taxonomy/taxonomy-manager';

export default function PostTagsPage() {
  return (
    <TaxonomyManager
      endpoint="/admin/posts/tags"
      queryKey="post-tags"
      title="Thẻ bài viết"
      description="Gắn thẻ giúp liên kết các bài viết cùng chủ đề"
      singular="thẻ"
      breadcrumbs={[{ label: 'Bài viết', href: '/posts' }, { label: 'Thẻ' }]}
      paginated
      routePrefix="post_tag"
      countKey="posts"
      countLabel="Bài viết"
      permission="posts.taxonomy"
      invalidate={['post-tags-all']}
    />
  );
}
