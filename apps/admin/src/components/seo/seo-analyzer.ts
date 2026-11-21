/** Phân tích SEO on-page đơn giản (giống Yoast/RankMath) chạy phía client */
export interface SeoCheck {
  id: string;
  ok: boolean | 'warn';
  message: string;
}

export interface SeoInput {
  title: string;
  seoTitle?: string | null;
  seoDescription?: string | null;
  keyword?: string | null;
  slug: string;
  content: string; // HTML hoặc text gộp từ block
  hasImage?: boolean;
}

const strip = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').toLowerCase();

export function analyzeSeo(input: SeoInput): { score: number; checks: SeoCheck[] } {
  const title = input.seoTitle || input.title || '';
  const desc = input.seoDescription || '';
  const text = strip(input.content || '');
  const words = text ? text.split(' ').length : 0;
  const kw = norm((input.keyword || '').trim());
  const checks: SeoCheck[] = [];

  checks.push({
    id: 'title-length',
    ok: title.length >= 30 && title.length <= 60 ? true : title.length ? 'warn' : false,
    message: `Tiêu đề SEO dài ${title.length} ký tự (nên 30–60).`,
  });
  checks.push({
    id: 'desc-length',
    ok: desc.length >= 120 && desc.length <= 160 ? true : desc.length ? 'warn' : false,
    message: desc.length ? `Mô tả meta dài ${desc.length} ký tự (nên 120–160).` : 'Chưa có mô tả meta.',
  });
  checks.push({ id: 'content-length', ok: words >= 300 ? true : words >= 100 ? 'warn' : false, message: `Nội dung có ${words} từ (nên ≥ 300 từ).` });
  checks.push({ id: 'slug', ok: input.slug && input.slug.length <= 75 ? true : 'warn', message: input.slug.length > 75 ? 'Đường dẫn hơi dài, nên ngắn gọn.' : 'Đường dẫn ngắn gọn, thân thiện.' });
  if (input.hasImage !== undefined) checks.push({ id: 'image', ok: input.hasImage ? true : 'warn', message: input.hasImage ? 'Có ảnh đại diện (dùng cho Open Graph).' : 'Nên thêm ảnh đại diện để chia sẻ mạng xã hội đẹp hơn.' });

  if (kw) {
    const inTitle = norm(title).includes(kw);
    const inDesc = norm(desc).includes(kw);
    const inSlug = norm(input.slug.replace(/-/g, ' ')).includes(kw.replace(/-/g, ' '));
    const count = norm(text).split(kw).length - 1;
    const density = words ? (count * kw.split(' ').length * 100) / words : 0;
    const first = norm(text.slice(0, 300)).includes(kw);
    checks.push({ id: 'kw-title', ok: inTitle, message: inTitle ? 'Từ khoá chính có trong tiêu đề SEO.' : 'Thêm từ khoá chính vào tiêu đề SEO.' });
    checks.push({ id: 'kw-desc', ok: inDesc, message: inDesc ? 'Từ khoá chính có trong mô tả meta.' : 'Thêm từ khoá chính vào mô tả meta.' });
    checks.push({ id: 'kw-slug', ok: inSlug ? true : 'warn', message: inSlug ? 'Từ khoá có trong đường dẫn.' : 'Nên đưa từ khoá vào đường dẫn.' });
    checks.push({ id: 'kw-first', ok: first ? true : 'warn', message: first ? 'Từ khoá xuất hiện ở đoạn đầu.' : 'Nên dùng từ khoá trong đoạn mở đầu.' });
    checks.push({
      id: 'kw-density',
      ok: density >= 0.5 && density <= 2.5 ? true : count ? 'warn' : false,
      message: `Mật độ từ khoá ${density.toFixed(1)}% (${count} lần, nên 0.5–2.5%).`,
    });
  } else {
    checks.push({ id: 'kw', ok: 'warn', message: 'Chưa đặt từ khoá chính để phân tích.' });
  }

  const score = Math.round((checks.reduce((s, c) => s + (c.ok === true ? 1 : c.ok === 'warn' ? 0.5 : 0), 0) / checks.length) * 100);
  return { score, checks };
}
