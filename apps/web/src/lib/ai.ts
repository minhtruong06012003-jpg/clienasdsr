/**
 * Tiện ích hiển thị AI Studio dùng chung: nhóm công cụ (menu), icon theo tên, định dạng tiền VND, nhãn trạng thái tác vụ.
 */
import {
  AudioLines,
  Bell,
  CircleHelp,
  CreditCard,
  Crown,
  ExternalLink,
  FileText,
  Gift,
  Globe,
  History,
  House,
  KeyRound,
  LayoutDashboard,
  Link2,
  MessageCircle,
  Phone,
  ReceiptText,
  Settings,
  Star,
  Wallet,
  BookOpen,
  Bot,
  Brush,
  Camera,
  Clapperboard,
  Code,
  Download,
  Eraser,
  Film,
  Gamepad2,
  GalleryHorizontal,
  GraduationCap,
  Heart,
  Headset,
  Image as ImageIcon,
  Images,
  Languages,
  Layers,
  type LucideIcon,
  Maximize2,
  Megaphone,
  MessageCircleHeart,
  MessagesSquare,
  Mic,
  MonitorUp,
  Music,
  Newspaper,
  Palette,
  PersonStanding,
  Replace,
  ScanFace,
  Scissors,
  ScrollText,
  ShieldCheck,
  Shirt,
  ShoppingBag,
  Sparkles,
  Ticket,
  Users,
  Video,
  WandSparkles,
  Wrench,
  Zap,
} from "lucide-react";
import { createElement } from "react";
import type { AiTaskStatus, AiTool } from "./types";

/**
 * Bảng icon theo tên (khớp `icon` admin đặt cho công cụ). Chỉ nạp các icon dùng tới để bundle nhỏ;
 * tên không có trong bảng -> Sparkles. Thêm icon mới: import từ lucide-react rồi thêm vào đây.
 */
const ICONS: Record<string, LucideIcon> = {
  "audio-lines": AudioLines,
  "book-open": BookOpen,
  bot: Bot,
  brush: Brush,
  camera: Camera,
  clapperboard: Clapperboard,
  code: Code,
  download: Download,
  eraser: Eraser,
  film: Film,
  "gallery-horizontal": GalleryHorizontal,
  "gamepad-2": Gamepad2,
  "graduation-cap": GraduationCap,
  heart: Heart,
  image: ImageIcon,
  images: Images,
  languages: Languages,
  megaphone: Megaphone,
  "message-circle-heart": MessageCircleHeart,
  "messages-square": MessagesSquare,
  mic: Mic,
  "monitor-up": MonitorUp,
  music: Music,
  newspaper: Newspaper,
  palette: Palette,
  "person-standing": PersonStanding,
  replace: Replace,
  "scan-face": ScanFace,
  "scroll-text": ScrollText,
  "shield-check": ShieldCheck,
  shirt: Shirt,
  "shopping-bag": ShoppingBag,
  sparkles: Sparkles,
  users: Users,
  video: Video,
  "wand-sparkles": WandSparkles,
  wrench: Wrench,
  // icon cho mục menu website (admin chọn ở trang Menu website — khớp MENU_ICONS ở apps/admin/src/components/web-menu/menu-editor.tsx)
  "layout-dashboard": LayoutDashboard,
  house: House,
  history: History,
  globe: Globe,
  "credit-card": CreditCard,
  wallet: Wallet,
  "receipt-text": ReceiptText,
  gift: Gift,
  "key-round": KeyRound,
  settings: Settings,
  crown: Crown,
  star: Star,
  bell: Bell,
  "file-text": FileText,
  "circle-help": CircleHelp,
  "message-circle": MessageCircle,
  phone: Phone,
  "external-link": ExternalLink,
  link: Link2,
  ticket: Ticket,
  headset: Headset,
};

export function toolIcon(name?: string | null): LucideIcon {
  return (name && ICONS[name]) || Sparkles;
}

/** Chọn icon nét mảnh sinh động cho từng nhóm model con ở menu bên trái (T-175/T-176) */
export function subToolIconOf(tool: Pick<AiTool, "name" | "icon" | "category" | "key">): LucideIcon {
  if (tool.icon && tool.icon !== "sparkles" && tool.icon !== "image" && tool.icon !== "video" && ICONS[tool.icon]) {
    return ICONS[tool.icon];
  }
  const s = `${tool.name ?? ""} ${tool.key ?? ""} ${tool.category ?? ""}`.toLowerCase();
  if (/làm nét|upscale|4k|hd|phục chế|tăng nét/.test(s)) return Maximize2;
  if (/xoá nền|tách nền|xoá vật thể|remove|eraser/.test(s)) return Eraser;
  if (/ghép video|stitch|cắt|cut/.test(s)) return Scissors;
  if (/tải video|tiktok|download/.test(s)) return Download;
  if (/đa model|multi|tổng hợp/.test(s)) return Layers;
  if (/tham chiếu|reference|nhiều ảnh/.test(s)) return Images;
  if (/khuôn mặt|hoán đổi|swap|face/.test(s)) return ScanFace;
  if (/motion|chuyển động|nhảy|dance/.test(s)) return PersonStanding;
  if (/văn bản thành video|text to video|chữ sang video/.test(s)) return Clapperboard;
  if (/chỉnh sửa ảnh|sửa ảnh|ghép ảnh|edit/.test(s)) {
    if (/gpt|muse|openai/.test(s)) return Palette;
    if (/grok/.test(s)) return WandSparkles;
    return Brush;
  }
  if (/grok|xai/.test(s)) return Zap;
  if (/gpt|openai/.test(s)) return Bot;
  if (/kling|seedance|minimax|veo|wan|vidu|ltx/.test(s)) return Film;
  if (/video/.test(s)) return Video;
  if (/gemini|nano|imagen/.test(s)) return Sparkles;
  if (/ảnh|image|photo/.test(s)) return Camera;
  return WandSparkles;
}

const MONO_MODEL_LOGOS = new Set([
  "capcut",
  "elevenlabs",
  "flux",
  "ideogram",
  "lightricks",
  "midjourney",
  "openai",
  "pika",
  "recraft",
  "runway",
  "suno",
  "topaz",
  "xai",
]);

/** Kiểm tra file logo SVG đơn sắc đen cần `dark:invert` trên nền tối */
export function isMonoModelLogo(logoUrl?: string | null): boolean {
  if (!logoUrl) return false;
  const m = /\/model-logos\/([a-z0-9_-]+)\.svg$/i.exec(logoUrl);
  return !!m && MONO_MODEL_LOGOS.has(m[1].toLowerCase());
}

/** Icon công cụ theo tên — tự động ưu tiên logo thương hiệu hãng AI (Grok, Gemini, GPT, MiniMax, Kling, Seedance...) nếu truyền `toolName` (T-439) */
export function ToolIcon({
  name,
  toolName,
  className,
}: {
  name?: string | null;
  toolName?: string | null;
  className?: string;
}) {
  const logo = toolName ? modelLogoOf(toolName) : null;
  if (logo) {
    const monoCls = isMonoModelLogo(logo) ? "dark:invert" : "";
    return createElement("img", {
      src: logo,
      alt: "",
      className: ["shrink-0 object-contain", monoCls, className].filter(Boolean).join(" "),
    });
  }
  return createElement(toolIcon(name), { className });
}

/**
 * Logo hãng làm ra model, đoán theo tên model (vd "Seedream 5.0" → ByteDance, "Nano Banana Pro" → Gemini).
 * File SVG ở `public/model-logos/` (lấy từ bộ @lobehub/icons-static-svg, giấy phép MIT).
 * Thứ tự quan trọng: luật đứng trước thắng (vd "Kling 3.0 Omni" phải khớp Kling trước luật "Omni Flash" của Google).
 */
const MODEL_LOGOS: [RegExp, string][] = [
  [/seedream|seedance|seededit|doubao|bytedance|dreamina/, "bytedance"],
  [/kling/, "kling"],
  [/grok|\bxai\b/, "xai"],
  [/flux/, "flux"],
  [/\bveo|lyria/, "deepmind"],
  [/nano|gemini|imagen|google|\bomni flash/, "gemini"],
  [/sora/, "sora"],
  [/gpt|dall|openai/, "openai"],
  [/qwen/, "qwen"],
  [/\bwan\b/, "alibaba"],
  [/hailuo/, "hailuo"],
  [/minimax/, "minimax"],
  [/eleven/, "elevenlabs"],
  [/suno/, "suno"],
  [/topaz/, "topaz"],
  [/midjourney/, "midjourney"],
  [/runway/, "runway"],
  [/luma/, "luma"],
  [/pika/, "pika"],
  [/vidu/, "vidu"],
  [/ideogram/, "ideogram"],
  [/recraft/, "recraft"],
  [/hunyuan/, "hunyuan"],
  [/\bltx/, "lightricks"],
  [/capcut/, "capcut"],
  [/stable diffusion|sdxl|stability/, "stability"],
];

/** Đường dẫn logo hãng của model (null = không nhận ra hãng, dùng icon công cụ như cũ) */
export function modelLogoOf(name?: string | null): string | null {
  const n = (name ?? "").toLowerCase();
  const hit = MODEL_LOGOS.find(([re]) => re.test(n));
  return hit ? `/model-logos/${hit[1]}.svg` : null;
}

/**
 * Nhóm công cụ trên menu. Danh sách (khoá, tên, icon, thứ tự) do admin quản lý ở AI Studio › Công cụ AI › Nhóm,
 * website đọc qua `GET /public/ai/categories` (hook `useCategories` trong lib/queries.ts). Giao diện chỉ dùng 2 tông trắng / đen (kiểu YupVox):
 * - `tone`: ô icon nền xám nhạt, icon màu chữ chính (menu, thẻ nhỏ);
 * - `art`: dải xám đậm cho thẻ lớn / ảnh bìa khi chưa có kết quả (mỗi nhóm lệch sắc độ một chút để phân biệt);
 * - `dot`: chấm nhỏ cạnh tên nhóm.
 */
const MONO_TONE = "text-foreground bg-muted";
const MONO_DOT = "bg-foreground/70";
/** Dải màu bìa: nhóm mặc định giữ đúng sắc độ cũ, nhóm admin thêm mới lấy lần lượt theo vị trí */
const ARTS = [
  "from-neutral-950 via-neutral-800 to-neutral-600",
  "from-zinc-900 via-zinc-700 to-zinc-500",
  "from-stone-900 via-stone-700 to-stone-500",
  "from-neutral-900 via-zinc-800 to-neutral-500",
  "from-zinc-950 via-neutral-800 to-zinc-600",
  "from-neutral-900 via-neutral-700 to-neutral-400",
];
const ART_OF: Record<string, string> = { video: ARTS[0], image: ARTS[1], voice: ARTS[2], audio: ARTS[3], text: ARTS[4], tools: ARTS[5] };

/** Nhóm như API trả về */
export interface AiCategoryRaw {
  key: string;
  label: string;
  icon: string | null;
  groupOrder?: string[];
}

/** Nhóm đã kèm icon + lớp màu để hiển thị */
export interface AiCategory {
  key: string;
  label: string;
  icon: LucideIcon;
  tone: string;
  art: string;
  dot: string;
  groupOrder?: string[];
}

/** Nhóm mặc định (khớp mặc định của API) — dùng khi chưa tải xong danh sách từ API */
export const DEFAULT_CATEGORIES: AiCategoryRaw[] = [
  { key: "video", label: "Video", icon: "video" },
  { key: "image", label: "Hình ảnh", icon: "image" },
  { key: "voice", label: "Giọng nói", icon: "mic" },
  { key: "audio", label: "Âm nhạc", icon: "music" },
  { key: "text", label: "Văn bản", icon: "scroll-text" },
  { key: "tools", label: "Công cụ", icon: "wrench" },
];

/** Danh sách nhóm từ API -> nhóm hiển thị (icon lạ / trống -> Sparkles) */
export function buildCategories(raw: AiCategoryRaw[]): AiCategory[] {
  return raw.map((c, i) => ({
    key: c.key,
    label: c.label,
    icon: toolIcon(c.icon),
    tone: MONO_TONE,
    art: ART_OF[c.key] ?? ARTS[i % ARTS.length],
    dot: MONO_DOT,
    ...(c.groupOrder?.length ? { groupOrder: c.groupOrder } : {}),
  }));
}

/** Tìm nhóm theo khoá; khoá không có trong danh sách -> nhóm tạm mang tên = khoá */
export function findCategory(list: AiCategory[], key: string): AiCategory {
  return list.find((c) => c.key === key) ?? { key, label: key, icon: Sparkles, tone: MONO_TONE, art: ARTS[ARTS.length - 1], dot: MONO_DOT };
}

/** Các nhóm model của công cụ (API cũ chỉ trả `group`) */
export const groupsOf = (x: AiTool): string[] => x.groups ?? (x.group ? [x.group] : []);

/**
 * Gộp các công cụ cùng nhóm model thành 1 dòng (menu, danh sách công cụ): tên hiển thị = tên nhóm, `group` = tên nhóm,
 * khách chọn model khác ngay trên trang công cụ. Một công cụ có thể ở nhiều nhóm.
 * Đại diện của nhóm (vị trí trong danh sách, link, nhóm cha) = model chỉ thuộc nhóm này đầu tiên, không có thì model đầu tiên —
 * để model dùng chung nhiều nhóm không kéo nhóm sang vị trí / nhóm cha khác (admin tab Nhóm model tính giống vậy).
 * Đại diện là model dùng chung thì link kèm `?g=<nhóm>` (xem `toolLink`).
 * Link + giá hiển thị của dòng nhóm lấy theo model rẻ nhất trong nhóm (`cheapestOf`) để khách bấm vào nhóm là mở model rẻ nhất.
 */
export function mergeModelGroups(tools: AiTool[] | undefined): AiTool[] {
  const list = tools ?? [];
  // nhóm -> công cụ đại diện
  const rep = new Map<string, AiTool>();
  for (const x of list) {
    const gs = groupsOf(x);
    for (const g of gs) {
      const cur = rep.get(g);
      if (!cur || (groupsOf(cur).length > 1 && gs.length === 1)) rep.set(g, x);
    }
  }
  const out: AiTool[] = [];
  for (const x of list) {
    const gs = groupsOf(x);
    if (!gs.length) out.push({ ...x, group: null });
    for (const g of gs) {
      if (rep.get(g) !== x) continue;
      // vị trí / nhóm cha / icon theo đại diện; ưu tiên mở model rẻ nhất đang hoạt động (không bảo trì), nếu cả nhóm bảo trì thì mở model rẻ nhất của nhóm
      const groupModels = list.filter((m) => groupsOf(m).includes(g));
      const activeModels = groupModels.filter((m) => !m.maintenance);
      const c = cheapestOf(activeModels.length ? activeModels : groupModels) ?? x;
      out.push({ ...x, key: c.key, groups: c.groups, group: g, pricing: c.pricing, price: c.price, maintenance: activeModels.length === 0, name: g });
    }
  }
  return out;
}

/** Giá dùng để xếp model: giá mặc định server tính, chưa có thì giá cố định khai báo; không xác định được -> Infinity (xuống cuối) */
export function priceRank(m: AiTool): number {
  if (typeof m.price === "number") return m.price;
  if (m.pricing.mode === "free") return 0;
  if (m.pricing.mode === "tiers") return Number(m.pricing.tier10to20 || m.pricing.base) || Infinity;
  return m.pricing.mode === "fixed" ? Number(m.pricing.base || m.pricing.perUnit) || Infinity : Infinity;
}

/** Model rẻ nhất trong danh sách (cùng giá thì giữ model xếp trước theo thứ tự admin) */
export function cheapestOf(models: AiTool[]): AiTool | undefined {
  let best: AiTool | undefined;
  for (const m of models) if (!best || priceRank(m) < priceRank(best)) best = m;
  return best;
}

/** Gom công cụ theo nhóm (theo thứ tự nhóm, bỏ nhóm rỗng); công cụ cùng nhóm model gộp thành 1 và giữ đúng thứ tự `groupOrder` do Admin kéo thả (T-496) */
export function groupTools(tools: AiTool[] | undefined, list: AiCategory[]) {
  const merged = mergeModelGroups(tools);
  return list
    .map((c) => {
      const catTools = merged.filter((t) => t.category === c.key);
      if (!c.groupOrder?.length) return { ...c, tools: catTools };
      const orderMap = new Map(c.groupOrder.map((g, i) => [g, i]));
      const groupIdxs: number[] = [];
      const groupItems: AiTool[] = [];
      catTools.forEach((t, idx) => {
        if (t.group && orderMap.has(t.group)) {
          groupIdxs.push(idx);
          groupItems.push(t);
        }
      });
      groupItems.sort((a, b) => (orderMap.get(a.group!) ?? 0) - (orderMap.get(b.group!) ?? 0));
      const nextTools = [...catTools];
      groupIdxs.forEach((idx, i) => {
        nextTools[idx] = groupItems[i];
      });
      return { ...c, tools: nextTools };
    })
    .filter((g) => g.tools.length);
}

/** Ô nhập prompt / văn bản chính của công cụ (textarea tên prompt, hoặc text bắt buộc), không có -> undefined */
export function promptFieldOf(tool: AiTool) {
  return tool.fields.find((f) => f.type === "textarea" && (f.name === "prompt" || (f.name === "text" && f.required)));
}

/**
 * Công cụ chạy được chỉ với một đoạn chữ (có ô prompt bắt buộc, không bắt buộc tải file) —
 * dùng cho ô "Bạn muốn tạo gì?" ở Tổng quan: gõ prompt rồi chuyển sang công cụ với prompt điền sẵn.
 */
export function promptTools(tools: AiTool[] | undefined) {
  const FILE = new Set(["image", "video", "audio", "file"]);
  return (tools ?? []).filter((t) => promptFieldOf(t)?.required && !t.fields.some((f) => f.required && FILE.has(f.type)));
}

/** Prompt mẫu theo nhóm (bấm để điền nhanh vào ô nhập ở Tổng quan) */
export const SAMPLE_PROMPTS: Record<string, string[]> = {
  video: ["Cảnh flycam bay qua ruộng bậc thang Mù Cang Chải lúc bình minh, sương mờ, điện ảnh", "Một chú mèo phi hành gia lơ lửng trong trạm vũ trụ, ánh sáng neon, chuyển động chậm", "Quảng cáo ly cà phê sữa đá, giọt nước lăn trên thành ly, cận cảnh, ánh sáng studio"],
  image: ["Chân dung cô gái mặc áo dài trắng giữa phố cổ Hội An, đèn lồng, ảnh chụp film", "Logo tối giản cho quán trà sữa, tông pastel, vector, nền trắng", "Căn phòng làm việc phong cách Bắc Âu, cây xanh, nắng sớm, ảnh chân thực"],
  voice: ["Xin chào! Chào mừng bạn đến với kênh của chúng tôi. Hôm nay mình sẽ chia sẻ 5 mẹo sống khoẻ mỗi ngày.", "Ưu đãi đặc biệt chỉ trong tuần này: giảm ngay 50% cho mọi sản phẩm. Nhanh tay đặt hàng nhé!"],
  audio: ["Nhạc lofi chill để học bài, piano nhẹ, mưa rơi", "Nhạc nền quảng cáo sôi động, EDM, tươi vui, 120 BPM", "Bản ballad acoustic buồn về mùa thu Hà Nội"],
};

/** Đoạn prompt / văn bản khách đã nhập của một tác vụ (hiển thị tóm tắt trong lịch sử) */
export function promptOf(input: Record<string, unknown> | null | undefined) {
  const v = input?.prompt ?? input?.text;
  return typeof v === "string" ? v.trim() : "";
}

/** Đường dẫn trang công cụ */
/** Link trang công cụ, kèm tham số query (bỏ giá trị trống) */
export const toolHref = (key: string, query?: Record<string, string | undefined>) => {
  const qs = new URLSearchParams(Object.entries(query ?? {}).filter((e): e is [string, string] => !!e[1])).toString();
  return `/tools/${encodeURIComponent(key)}${qs ? `?${qs}` : ""}`;
};

/** Link một dòng công cụ (đã gộp): model ở nhiều nhóm thì thêm `?g=<nhóm>` để trang công cụ biết đang ở nhóm nào */
export const toolLink = (x: AiTool, query?: Record<string, string | undefined>) => toolHref(x.key, { ...(x.group && groupsOf(x).length > 1 ? { g: x.group } : {}), ...query });

/** Khoá React / giá trị chọn duy nhất cho một dòng công cụ đã gộp (cùng công cụ có thể hiện ở nhiều nhóm) */
export const toolId = (x: AiTool) => `${x.key}|${x.group ?? ""}`;

/**
 * Định dạng số tiền VND cố định: 12500 -> "12.500đ" (số dư / giá chạy công cụ AI tính bằng VND, 1 credit cũ = 1đ).
 * Trong component nên dùng `useI18n().fmt.money` để theo tiền tệ khách chọn; hàm này chỉ là dự phòng khi không có `fmt`.
 */
export const fmtCredits = (n: number | undefined | null) => `${Math.round(Number(n) || 0).toLocaleString("vi-VN")}đ`;

/** Nhãn + màu trạng thái tác vụ */
export const TASK_STATUS: Record<AiTaskStatus, { label: string; className: string }> = {
  PENDING: { label: "Đang chờ", className: "bg-slate-100 text-slate-700 dark:bg-slate-500/15 dark:text-slate-300" },
  PROCESSING: { label: "Đang xử lý", className: "bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300" },
  SUCCEEDED: { label: "Hoàn thành", className: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300" },
  FAILED: { label: "Đã hoàn tiền", className: "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300" },
  CANCELLED: { label: "Đã huỷ", className: "bg-zinc-100 text-zinc-600 dark:bg-zinc-500/15 dark:text-zinc-300" },
};

/** Tác vụ còn đang chạy (cần hỏi lại trạng thái) */
export const isRunning = (s: AiTaskStatus) => s === "PENDING" || s === "PROCESSING";

/**
 * Mô tả cách tính giá ngắn gọn cho khách (giá tính bằng VND, trừ thẳng vào số dư ví).
 * `money`: hàm định dạng tiền (truyền `fmt.price` của useI18n để theo tiền tệ khách chọn), mặc định dạng "12.500đ".
 */
export function pricingText(tool: AiTool, t: (s: string, v?: Record<string, string | number>) => string, money: (v: unknown) => string = (v) => fmtCredits(Number(v))) {
  const p = tool.pricing;
  if (p.mode === "free") return t("Miễn phí");
  if (p.mode === "dynamic") {
    if (p.perUnit && p.unitLabel) return t("{per} / {unit}", { per: money(p.perUnit), unit: t(p.unitLabel) });
    return t("Giá theo lựa chọn");
  }
  if (p.mode === "tiers") return `10–20s: ${money(p.tier10to20)} · 20–30s: ${money(p.tier20to30)}`;
  if (p.perUnit && p.unitLabel) return p.base ? t("{base} + {per} / {unit}", { base: money(p.base), per: money(p.perUnit), unit: t(p.unitLabel) }) : t("{per} / {unit}", { per: money(p.perUnit), unit: t(p.unitLabel) });
  return t("{n} / lượt", { n: money(p.base) });
}

/**
 * Dịch chữ admin nhập cho gói nạp tiền (nhãn, mô tả). Mô tả dạng "99.050 credits / tháng" (chữ cũ admin còn lưu) có số thay đổi
 * nên tách số ra rồi dịch theo mẫu; chữ khác dịch nguyên câu (thiếu bản dịch thì giữ chữ gốc).
 */
export function planText(text: string, t: (s: string, v?: Record<string, string | number>) => string) {
  const m = /^([\d.,]+)\s*credits\s*\/\s*(tháng|năm|ngày|tuần)$/i.exec(text.trim());
  return m ? t(`{n} credits / ${m[2].toLowerCase()}`, { n: m[1] }) : t(text);
}
