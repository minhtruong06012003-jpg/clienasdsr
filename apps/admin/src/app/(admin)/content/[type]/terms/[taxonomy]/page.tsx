'use client';

import Link from 'next/link';
import { Suspense, use } from 'react';
import { Boxes, Loader2 } from 'lucide-react';
import { PageBody } from '@/components/common/page-header';
import { EmptyState } from '@/components/common/empty-state';
import { TermManager } from '@/components/content/term-manager';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/lib/auth';
import { useContentType, useTaxonomies } from '@/hooks/use-content-types';

/** Quản lý phân loại (term) của một taxonomy trong ngữ cảnh một loại nội dung: /content/<loại>/terms/<taxonomy> */
function TermsPage({ typeKey, taxonomyKey }: { typeKey: string; taxonomyKey: string }) {
  const { can, isDeveloper } = useAuth();
  const { type, isLoading } = useContentType(typeKey);
  const taxonomies = useTaxonomies();
  if (isLoading) {
    return (
      <div className="flex h-[60vh] items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (!type || !type.taxonomies.includes(taxonomyKey)) {
    return (
      <PageBody>
        <EmptyState icon={Boxes} title="Không tìm thấy phân loại" description={`Loại nội dung “${typeKey}” không có taxonomy “${taxonomyKey}”.`} action={(isDeveloper && can('content_types.manage')) ? <Button asChild variant="outline"><Link href="/content-types?tab=taxonomies">Quản lý taxonomy</Link></Button> : undefined} />
      </PageBody>
    );
  }
  return <TermManager type={type} taxonomyKey={taxonomyKey} taxonomy={taxonomies.data?.find((t) => t.key === taxonomyKey)} />;
}

export default function ContentTermsPage({ params }: { params: Promise<{ type: string; taxonomy: string }> }) {
  const { type, taxonomy } = use(params);
  return (
    <Suspense>
      <TermsPage typeKey={type} taxonomyKey={taxonomy} />
    </Suspense>
  );
}
