export function stripHtml(html: string | null | undefined): string {
  return (html ?? '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Thời gian đọc (phút) ~ 200 từ/phút */
export function readingTime(html: string | null | undefined): number {
  const words = stripHtml(html).split(' ').filter(Boolean).length;
  return Math.max(1, Math.round(words / 200));
}

export function excerptFrom(html: string | null | undefined, length = 160): string {
  const text = stripHtml(html);
  return text.length > length ? `${text.slice(0, length).replace(/\s+\S*$/, '')}…` : text;
}
