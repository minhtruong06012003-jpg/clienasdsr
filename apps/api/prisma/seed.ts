/**
 * Seed dữ liệu khởi tạo cho CMSNT Panel.
 * - An toàn khi chạy nhiều lần: chỉ tạo khi chưa có, KHÔNG xoá / ghi đè dữ liệu đã có.
 * - Dữ liệu demo (trang, bài viết, sản phẩm...) chỉ tạo 1 lần (đánh dấu bằng setting "_seed").
 *   Kèm dữ liệu demo bán hàng của CMSNT Panel (mặc định không tạo): SEED_DEMO=1 pnpm db:seed
 */
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import * as argon2 from 'argon2';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import sharp from 'sharp';
import { ALL_PERMISSIONS, slugify } from '@cmsnt/shared';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { demoSvg } from './demo-image.js';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
const UPLOAD_DIR = resolve(process.cwd(), process.env.UPLOAD_DIR ?? 'uploads');
const id = () => randomUUID();

async function seedLanguages() {
  const langs = [
    { code: 'vi', name: 'Tiếng Việt', nativeName: 'Tiếng Việt', flag: '🇻🇳', isDefault: true, sortOrder: 0 },
    { code: 'en', name: 'English', nativeName: 'English', flag: '🇬🇧', isDefault: false, sortOrder: 1 },
  ];
  for (const l of langs) await prisma.language.upsert({ where: { code: l.code }, create: l, update: {} });
}

async function seedRoles() {
  const content = ['pages.read', 'pages.write', 'pages.publish', 'posts.read', 'posts.write', 'posts.publish', 'posts.taxonomy', 'comments.manage', 'media.read', 'media.write', 'blocks.manage', 'menus.manage', 'seo.manage'];
  const roles = [
    // Nhà phát triển: toàn quyền + thấy các mục cấu hình kỹ thuật (xem DEVELOPER_ROLE trong @cmsnt/shared)
    { slug: 'developer', name: 'Nhà phát triển', description: 'Toàn quyền, thấy thêm các mục cấu hình kỹ thuật (loại nội dung, trường tuỳ chỉnh...)', permissions: ['*'], isSystem: true },
    { slug: 'administrator', name: 'Quản trị viên', description: 'Toàn quyền hệ thống', permissions: ['*'], isSystem: true },
    { slug: 'editor', name: 'Biên tập viên', description: 'Quản lý toàn bộ nội dung', permissions: ['admin.access', 'dashboard.view', 'reports.view', ...content, 'pages.delete', 'posts.delete', 'media.delete'], isSystem: true },
    {
      slug: 'shop_manager',
      name: 'Quản lý cửa hàng',
      description: 'Quản lý sản phẩm, đơn hàng, khách hàng',
      permissions: ['admin.access', 'dashboard.view', 'reports.view', 'products.read', 'products.write', 'products.publish', 'products.delete', 'products.taxonomy', 'orders.read', 'orders.write', 'coupons.manage', 'payments.read', 'einvoice.read', 'einvoice.write', 'einvoice.cancel', 'shipments.read', 'shipments.write', 'reviews.manage', 'users.read', 'media.read', 'media.write'],
      isSystem: true,
    },
    { slug: 'author', name: 'Tác giả', description: 'Viết bài, chờ duyệt', permissions: ['admin.access', 'dashboard.view', 'posts.read', 'posts.write', 'media.read', 'media.write'], isSystem: true },
    { slug: 'customer', name: 'Khách hàng', description: 'Thành viên mua hàng trên website', permissions: [], isSystem: true },
  ];
  for (const r of roles) await prisma.role.upsert({ where: { slug: r.slug }, create: r, update: {} });
  console.log(`  ✓ Vai trò (${ALL_PERMISSIONS.length} quyền khả dụng)`);
}

async function seedAdmin() {
  const email = (process.env.SEED_ADMIN_EMAIL ?? 'admin@cmsnt.co').toLowerCase();
  if (await prisma.user.findUnique({ where: { email } })) return;
  // tài khoản seed là của người dựng web -> vai trò Nhà phát triển; tài khoản giao chủ website tạo sau với vai trò Quản trị viên
  const role = await prisma.role.findUniqueOrThrow({ where: { slug: 'developer' } });
  await prisma.user.create({
    data: { email, name: 'Quản trị viên', passwordHash: await argon2.hash(process.env.SEED_ADMIN_PASSWORD ?? '123456', { type: argon2.argon2id }), roleId: role.id },
  });
  console.log(`  ✓ Tài khoản admin: ${email}`);
}

// ---------------------------------------------------------------------------
// Ảnh demo tạo bằng SVG -> sharp (không cần tải ảnh từ internet)
// ---------------------------------------------------------------------------
async function makeImage(name: string, opts: { w: number; h: number; from: string; to: string; title: string; sub?: string; emoji?: string }) {
  const svg = demoSvg(opts);
  const base = `seed/${slugify(name)}`;
  const buffer = await sharp(Buffer.from(svg)).jpeg({ quality: 85 }).toBuffer();
  const variants: Record<string, string> = {};
  const write = async (p: string, b: Buffer) => {
    const full = resolve(UPLOAD_DIR, p);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, b);
  };
  await write(`${base}.jpg`, buffer);
  for (const [key, size] of Object.entries({ thumb: 320, medium: 768, large: 1600 })) {
    if (opts.w <= size) continue;
    await write(`${base}-${key}.webp`, await sharp(buffer).resize({ width: size }).webp({ quality: 82 }).toBuffer());
    variants[key] = `${base}-${key}.webp`;
  }
  await write(`${base}.webp`, await sharp(buffer).webp({ quality: 85 }).toBuffer());
  variants.webp = `${base}.webp`;
  return prisma.media.create({
    data: { filename: `${slugify(name)}.jpg`, originalName: `${name}.jpg`, path: `${base}.jpg`, mimeType: 'image/jpeg', size: buffer.length, width: opts.w, height: opts.h, variants, alt: { vi: opts.title, en: opts.title } },
  });
}

const apiUrl = (process.env.API_PUBLIC_URL ?? 'http://localhost:4317').replace(/\/$/, '');
const ref = (m: { id: string; path: string; width: number | null; height: number | null }, alt = '') => ({ id: m.id, url: `${apiUrl}/uploads/${m.path}`, alt, width: m.width, height: m.height });

async function seedDemo() {
  if (await prisma.setting.findUnique({ where: { key: '_seed' } })) {
    console.log('  • Dữ liệu demo đã có, bỏ qua');
    return;
  }
  const admin = await prisma.user.findFirstOrThrow({ where: { role: { slug: { in: ['developer', 'administrator'] } } } });

  // --- media ---
  const heroImg = await makeImage('Hero banner', { w: 1920, h: 900, from: '#1e3a8a', to: '#7c3aed', title: '' });
  const aboutImg = await makeImage('Ve chung toi', { w: 1200, h: 900, from: '#0f766e', to: '#22c55e', title: 'Về chúng tôi', emoji: '🏪' });
  const banner1 = await makeImage('Banner sale', { w: 900, h: 500, from: '#dc2626', to: '#f97316', title: 'SALE 50%', sub: 'Cuối tuần vui vẻ' });
  const banner2 = await makeImage('Banner new', { w: 900, h: 500, from: '#0ea5e9', to: '#6366f1', title: 'Hàng mới về', sub: 'Bộ sưu tập 2026' });
  const logo = await makeImage('Logo', { w: 400, h: 120, from: '#2563eb', to: '#1d4ed8', title: 'CMSNT' });

  // --- product categories ---
  const catDefs = [
    { vi: 'Điện thoại', en: 'Phones', emoji: '📱', from: '#3b82f6', to: '#1e40af' },
    { vi: 'Laptop', en: 'Laptops', emoji: '💻', from: '#8b5cf6', to: '#5b21b6' },
    { vi: 'Phụ kiện', en: 'Accessories', emoji: '🎧', from: '#f59e0b', to: '#b45309' },
    { vi: 'Đồng hồ', en: 'Watches', emoji: '⌚', from: '#10b981', to: '#047857' },
  ];
  const cats = [];
  for (const [i, c] of catDefs.entries()) {
    const img = await makeImage(`cat-${c.en}`, { w: 600, h: 600, from: c.from, to: c.to, title: c.vi, emoji: c.emoji });
    cats.push(
      await prisma.productCategory.create({
        data: {
          imageId: img.id,
          sortOrder: i,
          translations: {
            create: [
              { locale: 'vi', name: c.vi, slug: slugify(c.vi), description: `Danh mục ${c.vi.toLowerCase()} chính hãng, giá tốt.` },
              { locale: 'en', name: c.en, slug: slugify(c.en), description: `Genuine ${c.en.toLowerCase()} at the best price.` },
            ],
          },
        },
      }),
    );
  }
  const brand = await prisma.brand.create({ data: { name: 'CMSNT', slug: 'cmsnt', description: 'Thương hiệu demo' } });

  // --- products ---
  const productDefs = [
    { vi: 'Điện thoại Nova X Pro', en: 'Nova X Pro Smartphone', cat: 0, price: 18990000, sale: 16490000, emoji: '📱', featured: true },
    { vi: 'Điện thoại Nova Lite', en: 'Nova Lite Smartphone', cat: 0, price: 7990000, sale: null, emoji: '📱', featured: false },
    { vi: 'Laptop Air 14 inch', en: 'Laptop Air 14"', cat: 1, price: 24990000, sale: 22990000, emoji: '💻', featured: true },
    { vi: 'Laptop Gaming Storm', en: 'Storm Gaming Laptop', cat: 1, price: 32990000, sale: null, emoji: '💻', featured: true },
    { vi: 'Tai nghe không dây Buds', en: 'Wireless Buds', cat: 2, price: 1990000, sale: 1490000, emoji: '🎧', featured: true },
    { vi: 'Sạc nhanh 65W', en: '65W Fast Charger', cat: 2, price: 590000, sale: null, emoji: '🔌', featured: false },
    { vi: 'Đồng hồ thông minh Fit', en: 'Fit Smartwatch', cat: 3, price: 3490000, sale: 2990000, emoji: '⌚', featured: true },
    { vi: 'Áo thun CMSNT (nhiều size)', en: 'CMSNT T-shirt', cat: 2, price: 250000, sale: null, emoji: '👕', featured: false, variable: true },
  ];
  const colors = [
    ['#0ea5e9', '#0369a1'],
    ['#f43f5e', '#9f1239'],
    ['#a855f7', '#6b21a8'],
    ['#14b8a6', '#0f766e'],
  ];
  for (const [i, p] of productDefs.entries()) {
    const [from, to] = colors[i % colors.length];
    const img = await makeImage(`product-${p.en}`, { w: 1000, h: 1000, from, to, title: p.vi, emoji: p.emoji });
    const img2 = await makeImage(`product-${p.en}-2`, { w: 1000, h: 1000, from: to, to: from, title: p.en, emoji: p.emoji });
    const desc = `<h2>Đặc điểm nổi bật</h2><p>${p.vi} với thiết kế hiện đại, hiệu năng mạnh mẽ và độ bền cao. Sản phẩm chính hãng, bảo hành 12 tháng.</p><ul><li>Chất liệu cao cấp</li><li>Bảo hành chính hãng</li><li>Giao hàng toàn quốc</li></ul>`;
    const descEn = `<h2>Highlights</h2><p>${p.en} with a modern design, powerful performance and durability. Genuine product with a 12-month warranty.</p>`;
    await prisma.product.create({
      data: {
        type: p.variable ? 'VARIABLE' : 'SIMPLE',
        status: 'PUBLISHED',
        publishedAt: new Date(),
        sku: `SKU-${1000 + i}`,
        price: p.price,
        salePrice: p.sale,
        manageStock: true,
        stockQuantity: 50,
        brandId: brand.id,
        featuredImageId: img.id,
        galleryIds: [img2.id],
        isFeatured: p.featured,
        soldCount: Math.floor(Math.random() * 200),
        specs: [
          { label: { vi: 'Bảo hành', en: 'Warranty' }, value: { vi: '12 tháng', en: '12 months' } },
          { label: { vi: 'Xuất xứ', en: 'Origin' }, value: { vi: 'Việt Nam', en: 'Vietnam' } },
        ],
        options: p.variable
          ? [
              { key: 'size', name: { vi: 'Kích cỡ', en: 'Size' }, values: ['S', 'M', 'L', 'XL'].map((v) => ({ value: v, label: { vi: v, en: v } })) },
              { key: 'color', name: { vi: 'Màu sắc', en: 'Color' }, values: [{ value: 'black', label: { vi: 'Đen', en: 'Black' } }, { value: 'white', label: { vi: 'Trắng', en: 'White' } }] },
            ]
          : [],
        variants: p.variable
          ? {
              create: ['S', 'M', 'L', 'XL'].flatMap((size, si) =>
                ['black', 'white'].map((color, ci) => ({ sku: `TSHIRT-${size}-${color}`.toUpperCase(), optionValues: { size, color }, price: 250000, stockQuantity: 20, sortOrder: si * 2 + ci })),
              ),
            }
          : undefined,
        categories: { create: [{ categoryId: cats[p.cat].id }] },
        translations: {
          create: [
            { locale: 'vi', name: p.vi, slug: slugify(p.vi), shortDescription: `${p.vi} chính hãng, giá tốt nhất thị trường.`, description: desc, seoDescription: `Mua ${p.vi} chính hãng, giá tốt, giao hàng nhanh toàn quốc.` },
            { locale: 'en', name: p.en, slug: slugify(p.en), shortDescription: `Genuine ${p.en} at the best price.`, description: descEn, seoDescription: `Buy genuine ${p.en} at the best price.` },
          ],
        },
      },
    });
  }

  // --- blog ---
  const blogCat = await prisma.postCategory.create({
    data: { translations: { create: [{ locale: 'vi', name: 'Tin tức', slug: 'tin-tuc' }, { locale: 'en', name: 'News', slug: 'news' }] } },
  });
  const tipsCat = await prisma.postCategory.create({
    data: { sortOrder: 1, translations: { create: [{ locale: 'vi', name: 'Mẹo hay', slug: 'meo-hay' }, { locale: 'en', name: 'Tips', slug: 'tips' }] } },
  });
  const tag = await prisma.postTag.create({ data: { translations: { create: [{ locale: 'vi', name: 'công nghệ', slug: 'cong-nghe' }, { locale: 'en', name: 'technology', slug: 'technology' }] } } });
  const postDefs = [
    { vi: 'Ra mắt website bán hàng mới', en: 'Launching our new online store', cat: blogCat.id },
    { vi: '5 mẹo chọn laptop phù hợp nhu cầu', en: '5 tips to choose the right laptop', cat: tipsCat.id },
    { vi: 'Cách bảo quản pin điện thoại bền lâu', en: 'How to keep your phone battery healthy', cat: tipsCat.id },
  ];
  for (const [i, p] of postDefs.entries()) {
    const img = await makeImage(`post-${p.en}`, { w: 1200, h: 675, from: colors[i][0], to: colors[i][1], title: p.vi });
    const content = `<p>${p.vi}. Đây là bài viết mẫu được tạo tự động khi khởi tạo hệ thống CMSNT Panel.</p><h2>Nội dung chính</h2><p>Bạn có thể chỉnh sửa bài viết này trong trang quản trị với trình soạn thảo trực quan, tối ưu SEO cho từng ngôn ngữ.</p><blockquote>CMSNT Panel - hệ thống quản trị website bán hàng chuyên nghiệp.</blockquote>`;
    await prisma.post.create({
      data: {
        status: 'PUBLISHED',
        publishedAt: new Date(Date.now() - i * 86400_000),
        authorId: admin.id,
        featuredImageId: img.id,
        isFeatured: i === 0,
        categories: { create: [{ categoryId: p.cat }] },
        tags: { create: [{ tagId: tag.id }] },
        translations: {
          create: [
            { locale: 'vi', title: p.vi, slug: slugify(p.vi), content, excerpt: `${p.vi} - bài viết mẫu.`, readingTime: 2, seoDescription: `${p.vi} - đọc ngay trên blog của chúng tôi.` },
            { locale: 'en', title: p.en, slug: slugify(p.en), content: `<p>${p.en}. This is a sample post.</p>`, excerpt: `${p.en} - sample post.`, readingTime: 1 },
          ],
        },
      },
    });
  }

  // --- global blocks ---
  const footerBlocks = (lang: 'vi' | 'en') => [
    {
      id: id(),
      type: 'cta',
      data: {
        title: lang === 'vi' ? 'Đăng ký nhận ưu đãi' : 'Get exclusive offers',
        text: lang === 'vi' ? 'Nhận ngay mã giảm 10% cho đơn hàng đầu tiên.' : 'Get 10% off your first order.',
        buttonLabel: lang === 'vi' ? 'Mua sắm ngay' : 'Shop now',
        buttonUrl: lang === 'vi' ? '/products' : '/en/products',
        style: 'primary',
      },
      settings: { paddingTop: 'md', paddingBottom: 'md' },
    },
  ];
  await prisma.globalBlock.create({
    data: { name: 'CTA chân trang', key: 'site-footer', type: 'section', translations: { create: [{ locale: 'vi', blocks: footerBlocks('vi') }, { locale: 'en', blocks: footerBlocks('en') }] } },
  });

  // --- pages ---
  const homeBlocks = (lang: 'vi' | 'en') => {
    const vi = lang === 'vi';
    const p = vi ? '' : '/en';
    return [
      {
        id: id(),
        type: 'hero',
        data: {
          eyebrow: vi ? 'Bộ sưu tập 2026' : '2026 Collection',
          title: vi ? 'Mua sắm thông minh, giá tốt mỗi ngày' : 'Smart shopping, great prices every day',
          subtitle: vi ? 'Hàng chính hãng, giao nhanh 2h, đổi trả trong 30 ngày.' : 'Genuine products, 2-hour delivery, 30-day returns.',
          image: ref(heroImg),
          primaryLabel: vi ? 'Mua ngay' : 'Shop now',
          primaryUrl: `${p}/products`,
          secondaryLabel: vi ? 'Xem khuyến mãi' : 'See deals',
          secondaryUrl: `${p}/products?onSale=1`,
          align: 'left',
          height: 'lg',
          overlay: 40,
        },
        settings: { container: 'full', paddingTop: 'none', paddingBottom: 'none' },
      },
      {
        id: id(),
        type: 'features',
        data: {
          title: '',
          columns: 4,
          style: 'inline',
          items: vi
            ? [
                { icon: 'truck', title: 'Giao hàng nhanh', text: 'Miễn phí đơn từ 500K' },
                { icon: 'shield-check', title: 'Chính hãng 100%', text: 'Hoàn tiền nếu hàng giả' },
                { icon: 'refresh-cw', title: 'Đổi trả 30 ngày', text: 'Thủ tục đơn giản' },
                { icon: 'headphones', title: 'Hỗ trợ 24/7', text: 'Hotline 1900 xxxx' },
              ]
            : [
                { icon: 'truck', title: 'Fast delivery', text: 'Free over 500K' },
                { icon: 'shield-check', title: '100% genuine', text: 'Money-back guarantee' },
                { icon: 'refresh-cw', title: '30-day returns', text: 'Hassle-free' },
                { icon: 'headphones', title: '24/7 support', text: 'Always here' },
              ],
        },
        settings: { paddingTop: 'md', paddingBottom: 'md' },
      },
      { id: id(), type: 'category-grid', data: { title: vi ? 'Danh mục nổi bật' : 'Top categories', limit: 4, columns: 4 }, settings: { paddingTop: 'lg', paddingBottom: 'md' } },
      {
        id: id(),
        type: 'product-grid',
        data: { title: vi ? 'Sản phẩm nổi bật' : 'Featured products', subtitle: vi ? 'Được khách hàng yêu thích nhất' : 'Customer favorites', source: 'featured', limit: 8, columns: 4, viewAllLabel: vi ? 'Xem tất cả' : 'View all', viewAllUrl: `${p}/products` },
        settings: { paddingTop: 'lg', paddingBottom: 'lg' },
      },
      {
        id: id(),
        type: 'banner-grid',
        data: {
          columns: 2,
          items: [
            { image: ref(banner1), title: vi ? 'Sale cuối tuần' : 'Weekend sale', url: `${p}/products?onSale=1` },
            { image: ref(banner2), title: vi ? 'Hàng mới về' : 'New arrivals', url: `${p}/products?sort=newest` },
          ],
        },
        settings: { paddingTop: 'md', paddingBottom: 'md' },
      },
      {
        id: id(),
        type: 'product-carousel',
        data: { title: vi ? 'Đang giảm giá' : 'On sale', source: 'on_sale', limit: 10 },
        settings: { paddingTop: 'lg', paddingBottom: 'lg', background: '#f8fafc' },
      },
      {
        id: id(),
        type: 'image-text',
        data: {
          image: ref(aboutImg),
          eyebrow: vi ? 'Câu chuyện thương hiệu' : 'Our story',
          title: vi ? 'Hơn 10 năm đồng hành cùng khách hàng' : 'Over 10 years serving customers',
          html: vi
            ? '<p>Chúng tôi mang đến sản phẩm công nghệ chính hãng với dịch vụ tận tâm. Mọi đơn hàng đều được kiểm tra kỹ trước khi giao.</p>'
            : '<p>We deliver genuine tech products with dedicated service. Every order is carefully checked before shipping.</p>',
          imagePosition: 'left',
          buttonLabel: vi ? 'Tìm hiểu thêm' : 'Learn more',
          buttonUrl: vi ? '/gioi-thieu' : '/en/about-us',
        },
        settings: { paddingTop: 'xl', paddingBottom: 'xl' },
      },
      {
        id: id(),
        type: 'stats',
        data: {
          items: vi
            ? [
                { value: '50K+', label: 'Khách hàng' },
                { value: '1.200+', label: 'Sản phẩm' },
                { value: '63', label: 'Tỉnh thành' },
                { value: '4.9/5', label: 'Đánh giá' },
              ]
            : [
                { value: '50K+', label: 'Customers' },
                { value: '1,200+', label: 'Products' },
                { value: '63', label: 'Provinces' },
                { value: '4.9/5', label: 'Rating' },
              ],
        },
        settings: { paddingTop: 'lg', paddingBottom: 'lg', background: '#0f172a', textColor: '#ffffff' },
      },
      {
        id: id(),
        type: 'testimonials',
        data: {
          title: vi ? 'Khách hàng nói gì' : 'What customers say',
          items: [
            { name: 'Minh Anh', role: vi ? 'Hà Nội' : 'Hanoi', content: vi ? 'Giao hàng siêu nhanh, đóng gói cẩn thận. Sẽ ủng hộ dài dài!' : 'Super fast delivery and careful packaging!', rating: 5 },
            { name: 'Quốc Bảo', role: 'TP.HCM', content: vi ? 'Tư vấn nhiệt tình, giá tốt hơn nhiều nơi khác.' : 'Helpful advice and better prices.', rating: 5 },
            { name: 'Thu Hà', role: vi ? 'Đà Nẵng' : 'Da Nang', content: vi ? 'Sản phẩm đúng mô tả, bảo hành nhanh gọn.' : 'Exactly as described, quick warranty.', rating: 4 },
          ],
        },
        settings: { paddingTop: 'lg', paddingBottom: 'lg' },
      },
      { id: id(), type: 'post-list', data: { title: vi ? 'Tin tức & mẹo hay' : 'News & tips', source: 'latest', limit: 3, columns: 3 }, settings: { paddingTop: 'lg', paddingBottom: 'lg' } },
      {
        id: id(),
        type: 'faq',
        data: {
          title: vi ? 'Câu hỏi thường gặp' : 'FAQ',
          items: vi
            ? [
                { question: 'Thời gian giao hàng bao lâu?', answer: '<p>Nội thành 2h - 24h, tỉnh khác 2-4 ngày làm việc.</p>' },
                { question: 'Tôi có thể đổi trả không?', answer: '<p>Có, đổi trả miễn phí trong 30 ngày nếu sản phẩm lỗi do nhà sản xuất.</p>' },
                { question: 'Có hỗ trợ trả góp không?', answer: '<p>Hỗ trợ trả góp 0% qua thẻ tín dụng.</p>' },
              ]
            : [
                { question: 'How long does delivery take?', answer: '<p>2-24 hours in the city, 2-4 business days elsewhere.</p>' },
                { question: 'Can I return products?', answer: '<p>Yes, free returns within 30 days for manufacturer defects.</p>' },
              ],
        },
        settings: { paddingTop: 'lg', paddingBottom: 'lg', container: 'narrow' },
      },
      { id: id(), type: 'global-block', data: { blockKey: 'site-footer' }, settings: { paddingTop: 'none', paddingBottom: 'none' } },
    ];
  };

  const home = await prisma.page.create({
    data: {
      status: 'PUBLISHED',
      publishedAt: new Date(),
      authorId: admin.id,
      translations: {
        create: [
          { locale: 'vi', title: 'Trang chủ', slug: 'trang-chu', blocks: homeBlocks('vi'), seoTitle: 'CMSNT Shop - Mua sắm thông minh', seoDescription: 'Cửa hàng công nghệ chính hãng, giá tốt, giao nhanh toàn quốc.' },
          { locale: 'en', title: 'Home', slug: 'home', blocks: homeBlocks('en'), seoTitle: 'CMSNT Shop - Smart shopping', seoDescription: 'Genuine tech store with great prices and fast delivery.' },
        ],
      },
    },
  });

  const about = await prisma.page.create({
    data: {
      status: 'PUBLISHED',
      publishedAt: new Date(),
      authorId: admin.id,
      translations: {
        create: [
          {
            locale: 'vi',
            title: 'Giới thiệu',
            slug: 'gioi-thieu',
            seoDescription: 'Giới thiệu về CMSNT Shop',
            blocks: [
              { id: id(), type: 'heading', data: { title: 'Giới thiệu', subtitle: 'Câu chuyện của chúng tôi', level: 'h1', align: 'center' }, settings: { paddingTop: 'xl', paddingBottom: 'sm' } },
              { id: id(), type: 'rich-text', data: { html: '<p>CMSNT Shop được thành lập với sứ mệnh mang sản phẩm chính hãng đến mọi nhà.</p><h2>Tầm nhìn</h2><p>Trở thành nhà bán lẻ công nghệ được tin cậy nhất.</p>' }, settings: { container: 'narrow', paddingTop: 'md', paddingBottom: 'xl' } },
            ],
          },
          {
            locale: 'en',
            title: 'About us',
            slug: 'about-us',
            blocks: [
              { id: id(), type: 'heading', data: { title: 'About us', subtitle: 'Our story', level: 'h1', align: 'center' }, settings: { paddingTop: 'xl', paddingBottom: 'sm' } },
              { id: id(), type: 'rich-text', data: { html: '<p>CMSNT Shop was founded to bring genuine products to everyone.</p>' }, settings: { container: 'narrow', paddingTop: 'md', paddingBottom: 'xl' } },
            ],
          },
        ],
      },
    },
  });

  const contact = await prisma.page.create({
    data: {
      status: 'PUBLISHED',
      publishedAt: new Date(),
      authorId: admin.id,
      translations: {
        create: [
          {
            locale: 'vi',
            title: 'Liên hệ',
            slug: 'lien-he',
            seoDescription: 'Liên hệ với CMSNT Shop',
            blocks: [
              { id: id(), type: 'heading', data: { title: 'Liên hệ với chúng tôi', subtitle: 'Chúng tôi luôn sẵn sàng hỗ trợ bạn', level: 'h1', align: 'center' }, settings: { paddingTop: 'xl', paddingBottom: 'sm' } },
            ],
          },
          {
            locale: 'en',
            title: 'Contact',
            slug: 'contact',
            blocks: [
              { id: id(), type: 'heading', data: { title: 'Contact us', subtitle: 'We are here to help', level: 'h1', align: 'center' }, settings: { paddingTop: 'xl', paddingBottom: 'sm' } },
            ],
          },
        ],
      },
    },
  });

  // --- menus ---
  const label = (vi: string, en: string) => ({ vi, en });
  await prisma.menu.create({
    data: {
      name: 'Menu chính',
      location: 'header',
      items: [
        { id: id(), label: label('Trang chủ', 'Home'), type: 'home', children: [] },
        {
          id: id(),
          label: label('Sản phẩm', 'Products'),
          type: 'custom',
          url: '/products',
          children: cats.map((c, i) => ({ id: id(), label: label(catDefs[i].vi, catDefs[i].en), type: 'product_category', refId: c.id, children: [] })),
        },
        { id: id(), label: label('Tin tức', 'Blog'), type: 'custom', url: '/blog', children: [] },
        { id: id(), label: label('Giới thiệu', 'About'), type: 'page', refId: about.id, children: [] },
        { id: id(), label: label('Liên hệ', 'Contact'), type: 'page', refId: contact.id, children: [] },
      ],
    },
  });
  await prisma.menu.create({
    data: {
      name: 'Menu chân trang',
      location: 'footer',
      items: [
        { id: id(), label: label('Giới thiệu', 'About'), type: 'page', refId: about.id, children: [] },
        { id: id(), label: label('Liên hệ', 'Contact'), type: 'page', refId: contact.id, children: [] },
        { id: id(), label: label('Tra cứu đơn hàng', 'Track order'), type: 'custom', url: '/order-tracking', children: [] },
        { id: id(), label: label('Tin tức', 'Blog'), type: 'custom', url: '/blog', children: [] },
      ],
    },
  });

  // --- coupon ---
  await prisma.coupon.create({ data: { code: 'WELCOME10', description: 'Giảm 10% cho khách mới', type: 'PERCENT', value: 10, maxDiscount: 200000 } });

  // --- settings ---
  const setting = (key: string, value: object, isPublic = true) => prisma.setting.upsert({ where: { key }, create: { key, value, isPublic }, update: {} });
  await setting('general', { homepageId: home.id, logo: logo.id });
  await setting('contact', {
    companyName: 'Công ty TNHH CMSNT',
    email: 'hello@cmsnt.local',
    phone: '0900 000 000',
    hotline: '1900 0000',
    address: { vi: '123 Đường ABC, Quận 1, TP. Hồ Chí Minh', en: '123 ABC Street, District 1, Ho Chi Minh City' },
    workingHours: { vi: '8:00 - 21:00 (T2 - CN)', en: '8:00 - 21:00 (Mon - Sun)' },
  });
  await setting('seo', { defaultOgImage: heroImg.id, organizationLogo: logo.id });
  await prisma.setting.create({ data: { key: '_seed', value: { at: new Date().toISOString() } } });
  console.log('  ✓ Dữ liệu demo: trang, bài viết, sản phẩm, menu, form, block, mã giảm giá');
}


/**
 * Gói nạp tiền mặc định (chỉ tạo khi bảng trống): trả `price`, nhận `credits` đồng vào số dư ví; gói lớn tặng thêm
 * (% tặng thêm tự tính so với đơn giá của gói nhỏ nhất).
 */
async function seedPlans() {
  if (await prisma.creditPlan.count()) return;
  const packs = [
    { price: 50_000, credits: 50_000 },
    { price: 100_000, credits: 102_000 },
    { price: 200_000, credits: 206_000 },
    { price: 500_000, credits: 525_000, highlight: true, badge: 'Phổ biến' },
    { price: 1_000_000, credits: 1_080_000 },
    { price: 2_000_000, credits: 2_200_000, badge: 'Giá trị nhất' },
  ];
  for (const [i, p] of packs.entries()) {
    await prisma.creditPlan.create({ data: { ...p, slug: `nap-${p.price / 1000}k`, name: `Gói ${p.price.toLocaleString('vi-VN')}đ`, sortOrder: i } });
  }
  console.log(`  ✓ Gói nạp tiền (${packs.length} gói)`);
}

/** Bật sẵn các tính năng cần cho website AI (tắt cửa hàng / giỏ hàng — web không bán sản phẩm vật lý) */
async function seedSiteDefaults() {
  if (await prisma.setting.findUnique({ where: { key: 'features' } })) return;
  await prisma.setting.create({ data: { key: 'features', value: { shop: false, blog: true, accounts: true, comments: true, reviews: false, wallet: true, wishlist: false, search: true }, isPublic: true } });
  console.log('  ✓ Tính năng mặc định (tắt cửa hàng)');
}

async function main() {
  console.log('🌱 Seeding nov.ai.vn...');
  await seedLanguages();
  await seedRoles();
  await seedAdmin();
  await seedPlans();
  await seedSiteDefaults();
  if (process.env.SEED_DEMO === '1') await seedDemo();
  console.log('✅ Hoàn tất');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
