import { Skeleton } from '@/components/ui/skeleton';

/** Khung xương hiển thị trong lúc trang quản trị đang tải */
export default function Loading() {
  return (
    <div className="animate-in fade-in duration-300">
      <div className="flex min-h-14 items-center gap-3 border-b bg-card px-4 py-2 md:px-6">
        <Skeleton className="size-7 rounded-md" />
        <div className="space-y-1.5">
          <Skeleton className="h-3 w-32" />
          <Skeleton className="h-5 w-48" />
        </div>
        <Skeleton className="ml-auto h-8 w-24 rounded-lg" />
      </div>
      <div className="space-y-4 p-4 md:p-6">
        <div className="flex gap-2">
          <Skeleton className="h-8 w-64 rounded-lg" />
          <Skeleton className="h-8 w-28 rounded-lg" />
        </div>
        <div className="space-y-3 rounded-xl border bg-card p-4">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="flex items-center gap-4">
              <Skeleton className="size-10 rounded-md" />
              <Skeleton className="h-4 flex-1" />
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-4 w-16" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
