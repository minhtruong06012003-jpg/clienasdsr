'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

/** Carousel nhẹ dùng CSS scroll-snap, có tự chạy (autoplay) tuỳ chọn */
export function Slider({ children, autoplay = false, interval = 5, perView = 'full', showDots = true }: { children: ReactNode[]; autoplay?: boolean; interval?: number; perView?: 'full' | 'cards'; showDots?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState(0);
  const count = children.length;

  const go = (i: number) => {
    const el = ref.current;
    if (!el) return;
    const item = el.children[(i + count) % count] as HTMLElement | undefined;
    if (item) el.scrollTo({ left: item.offsetLeft - el.offsetLeft, behavior: 'smooth' });
  };

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => {
      const w = (el.children[0] as HTMLElement | undefined)?.offsetWidth || el.clientWidth;
      setIndex(Math.round(el.scrollLeft / w));
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    if (!autoplay || count < 2) return;
    const t = setInterval(() => go(index + 1), Math.max(2, interval) * 1000);
    return () => clearInterval(t);
  });

  return (
    <div className="relative">
      <div ref={ref} className="flex snap-x snap-mandatory gap-4 overflow-x-auto scroll-smooth [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {children.map((child, i) => (
          <div key={i} className={perView === 'full' ? 'w-full shrink-0 snap-start' : 'w-[46%] shrink-0 snap-start @3xl:w-[31%] @5xl:w-[23.5%]'}>
            {child}
          </div>
        ))}
      </div>
      {count > 1 && (
        <>
          <button type="button" aria-label="Previous" onClick={() => go(index - 1)} className="absolute left-2 top-1/2 hidden -translate-y-1/2 rounded-full bg-white/90 p-2 shadow @3xl:block">
            <ChevronLeft className="h-5 w-5" />
          </button>
          <button type="button" aria-label="Next" onClick={() => go(index + 1)} className="absolute right-2 top-1/2 hidden -translate-y-1/2 rounded-full bg-white/90 p-2 shadow @3xl:block">
            <ChevronRight className="h-5 w-5" />
          </button>
          {showDots && perView === 'full' && (
            <div className="absolute bottom-4 left-1/2 flex -translate-x-1/2 gap-2">
              {children.map((_, i) => (
                <button key={i} type="button" aria-label={`Slide ${i + 1}`} onClick={() => go(i)} className={`h-2 rounded-full transition-all ${i === index ? 'w-6 bg-white' : 'w-2 bg-white/60'}`} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
