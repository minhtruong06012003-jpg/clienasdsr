/**
 * Bảng phối màu giao diện (theme) cho website khách.
 * - Mỗi bảng màu có 2 biến thể Sáng / Tối, mỗi biến thể chỉ cần 6 màu gốc (seed);
 *   các biến CSS còn lại (muted, border, accent, sidebar...) được suy ra bằng color-mix.
 * - Lựa chọn lưu ở localStorage của trình duyệt; CSS sinh sẵn cũng được lưu để script đầu trang
 *   chèn ngay khi tải (tránh nháy màu mặc định).
 */

/** 6 màu gốc của một biến thể (mã hex #rrggbb) */
export type PaletteSeeds = {
  /** màu chủ đạo: nút, mục menu đang chọn, liên kết */
  primary: string;
  /** màu thứ hai cho dải gradient (logo, thẻ ví, nút nổi) */
  primary2: string;
  /** nền trang */
  background: string;
  /** nền thẻ / hộp thoại */
  surface: string;
  /** nền thanh menu bên trái */
  sidebar: string;
  /** màu chữ chính */
  text: string;
} & Partial<StatusSeeds>;

/**
 * Màu nút / badge (không bắt buộc): bảng màu không đặt thì dùng màu mặc định trong globals.css.
 * Bảng màu cũ (chỉ có 6 màu gốc) vẫn hợp lệ.
 */
export type StatusSeeds = {
  /** nút hành động chính (ĐẶT HÀNG) + ô thành tiền */
  action: string;
  /** thành công: badge Bảo hành, nút Hỗ trợ, thông báo thành công */
  success: string;
  /** thông tin: badge Cho phép huỷ, hộp tổng chi phí */
  info: string;
  /** cảnh báo: badge loại dịch vụ, thông báo cần chú ý */
  warning: string;
  /** nguy hiểm: hộp Lưu ý quan trọng, lỗi, nút xoá */
  danger: string;
};

export const STATUS_KEYS = ["action", "success", "info", "warning", "danger"] as const;

/** Màu nút / badge mặc định của từng chế độ (khớp globals.css) */
export const DEFAULT_STATUS: Record<"light" | "dark", StatusSeeds> = {
  light: { action: "#111111", success: "#047857", info: "#0369a1", warning: "#a14a05", danger: "#c81e3a" },
  dark: { action: "#fafafa", success: "#34d399", info: "#38bdf8", warning: "#fbbf24", danger: "#f87171" },
};

/** Một bảng màu hoàn chỉnh (mẫu có sẵn hoặc do khách tự phối) */
export type Palette = {
  id: string;
  name: string;
  light: PaletteSeeds;
  dark: PaletteSeeds;
  /** độ bo góc (rem) */
  radius: number;
};

/** Lựa chọn đang lưu: id bảng màu đang dùng + các bảng khách tự phối */
export type PaletteState = { activeId: string; customs: Palette[] };

export const PALETTE_STORAGE_KEY = "smm-web-palette";
/** CSS đã sinh của bảng màu đang dùng — script đầu trang đọc khoá này */
export const PALETTE_CSS_KEY = "smm-web-palette-css";
/** id thẻ <style> chứa CSS bảng màu */
export const PALETTE_STYLE_ID = "smm-palette";
export const DEFAULT_PALETTE_ID = "default";
/** Số bảng màu tự phối tối đa được lưu */
export const MAX_CUSTOM_PALETTES = 12;
export const DEFAULT_RADIUS = 0.75;

/** Các bảng màu có sẵn (mẫu đầu tiên trùng màu gốc trong globals.css nên không cần chèn CSS) */
export const PRESET_PALETTES: Palette[] = [
  {
    id: "default",
    name: "Trắng đen",
    radius: DEFAULT_RADIUS,
    light: { primary: "#111111", primary2: "#52525b", background: "#f7f7f8", surface: "#ffffff", sidebar: "#ffffff", text: "#0a0a0a" },
    dark: { primary: "#fafafa", primary2: "#d4d4d8", background: "#070708", surface: "#0f0f11", sidebar: "#0a0a0b", text: "#f4f4f5" },
  },
  {
    // bảng màu mặc định cũ, giữ lại để khách vẫn chọn được
    id: "blue",
    name: "Xanh dương",
    radius: DEFAULT_RADIUS,
    light: { primary: "#1e4fd8", primary2: "#6a5cf6", background: "#f4f6fb", surface: "#ffffff", sidebar: "#ffffff", text: "#0f172a" },
    dark: { primary: "#3d6ef0", primary2: "#8b7cf8", background: "#0b1020", surface: "#131a2c", sidebar: "#0f1526", text: "#e6eaf2" },
  },
  {
    id: "galaxy",
    name: "Tím thiên hà",
    radius: DEFAULT_RADIUS,
    light: { primary: "#7c3aed", primary2: "#c026d3", background: "#f6f3ff", surface: "#ffffff", sidebar: "#ffffff", text: "#241a3d" },
    dark: { primary: "#8b5cf6", primary2: "#d946ef", background: "#0d0b26", surface: "#16133b", sidebar: "#110e30", text: "#efeaff" },
  },
  {
    id: "matrix",
    name: "Xanh lá",
    radius: DEFAULT_RADIUS,
    light: { primary: "#16a34a", primary2: "#0d9488", background: "#f2f8f4", surface: "#ffffff", sidebar: "#ffffff", text: "#14291d" },
    dark: { primary: "#22c55e", primary2: "#10b981", background: "#07140d", surface: "#0d1f15", sidebar: "#0a1a11", text: "#e8f6ee" },
  },
  {
    id: "sakura",
    name: "Hồng anh đào",
    radius: DEFAULT_RADIUS,
    light: { primary: "#ec4899", primary2: "#f43f5e", background: "#fdf3f7", surface: "#ffffff", sidebar: "#ffffff", text: "#3a1a2a" },
    dark: { primary: "#f472b6", primary2: "#fb7185", background: "#1a0d14", surface: "#26131d", sidebar: "#200f18", text: "#fbecf3" },
  },
  {
    id: "sunset",
    name: "Cam hoàng hôn",
    radius: DEFAULT_RADIUS,
    light: { primary: "#ea580c", primary2: "#f59e0b", background: "#fdf6ef", surface: "#ffffff", sidebar: "#ffffff", text: "#33200f" },
    dark: { primary: "#fb923c", primary2: "#fbbf24", background: "#1a120b", surface: "#261a10", sidebar: "#20160d", text: "#fbf1e7" },
  },
  {
    id: "lavender",
    name: "Oải hương",
    radius: DEFAULT_RADIUS,
    light: { primary: "#6366f1", primary2: "#a855f7", background: "#f3f3fe", surface: "#ffffff", sidebar: "#ffffff", text: "#1e1f3d" },
    dark: { primary: "#818cf8", primary2: "#c084fc", background: "#10112a", surface: "#181a3a", sidebar: "#141533", text: "#eceefe" },
  },
  {
    id: "ocean",
    name: "Xanh ngọc",
    radius: DEFAULT_RADIUS,
    light: { primary: "#0891b2", primary2: "#14b8a6", background: "#f0f8fa", surface: "#ffffff", sidebar: "#ffffff", text: "#102a31" },
    dark: { primary: "#22d3ee", primary2: "#2dd4bf", background: "#071518", surface: "#0d2126", sidebar: "#0a1b1f", text: "#e6f7fa" },
  },
  {
    id: "ruby",
    name: "Đỏ ruby",
    radius: DEFAULT_RADIUS,
    light: { primary: "#dc2626", primary2: "#e11d48", background: "#fbf3f3", surface: "#ffffff", sidebar: "#ffffff", text: "#331414" },
    dark: { primary: "#ef4444", primary2: "#f43f5e", background: "#170b0b", surface: "#231111", sidebar: "#1d0e0e", text: "#fbeaea" },
  },
  {
    id: "gold",
    name: "Vàng hoàng kim",
    radius: DEFAULT_RADIUS,
    light: { primary: "#ca8a04", primary2: "#ea580c", background: "#fbf8ee", surface: "#ffffff", sidebar: "#ffffff", text: "#2e250c" },
    dark: { primary: "#facc15", primary2: "#f59e0b", background: "#14110a", surface: "#201b0f", sidebar: "#1a160c", text: "#faf5e4" },
  },
  {
    id: "graphite",
    name: "Than chì",
    radius: 0.5,
    light: { primary: "#334155", primary2: "#64748b", background: "#f5f5f6", surface: "#ffffff", sidebar: "#ffffff", text: "#18181b" },
    dark: { primary: "#64748b", primary2: "#94a3b8", background: "#0b0b0d", surface: "#151518", sidebar: "#111114", text: "#f4f4f5" },
  },
];

/* ---------------- Tiện ích màu ---------------- */

const HEX_RE = /^#[0-9a-f]{6}$/i;

/** Mã hex hợp lệ dạng #rrggbb */
export function isHex(v: unknown): v is string {
  return typeof v === "string" && HEX_RE.test(v);
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex(r: number, g: number, b: number) {
  return `#${[r, g, b].map((x) => Math.round(Math.min(255, Math.max(0, x))).toString(16).padStart(2, "0")).join("")}`;
}

/** Độ sáng tương đối theo WCAG (0..1) */
function luminance(hex: string) {
  const [r, g, b] = hexToRgb(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Tỉ lệ tương phản WCAG giữa 2 màu (1..21) */
export function contrastRatio(a: string, b: string) {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

/** Chọn chữ trắng hoặc gần đen trên nền màu cho dễ đọc nhất */
export function readableOn(hex: string) {
  return contrastRatio(hex, "#ffffff") >= contrastRatio(hex, "#111827") ? "#ffffff" : "#111827";
}

/** Trộn 2 màu: weight là tỉ lệ của màu a (0..1) */
export function mixHex(a: string, b: string, weight: number) {
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  return rgbToHex(ca[0] * weight + cb[0] * (1 - weight), ca[1] * weight + cb[1] * (1 - weight), ca[2] * weight + cb[2] * (1 - weight));
}

/** Xoay sắc độ (hue) của màu một góc (độ) — dùng để tạo màu gradient thứ hai */
function rotateHue(hex: string, deg: number) {
  const [r, g, b] = hexToRgb(hex).map((c) => c / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
  }
  h = (h * 60 + deg + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r1, g1, b1] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return rgbToHex((r1 + m) * 255, (g1 + m) * 255, (b1 + m) * 255);
}

/** Tạo nhanh cả 2 biến thể Sáng/Tối chỉ từ một màu chủ đạo (nền phớt cùng tông màu) */
export function seedsFromPrimary(primary: string): { light: PaletteSeeds; dark: PaletteSeeds } {
  const primary2 = rotateHue(primary, -28);
  return {
    light: {
      primary,
      primary2,
      background: mixHex(primary, "#f7f8fa", 0.05),
      surface: "#ffffff",
      sidebar: "#ffffff",
      text: mixHex(primary, "#141820", 0.12),
    },
    dark: {
      primary: mixHex(primary, "#ffffff", 0.85),
      primary2: mixHex(primary2, "#ffffff", 0.85),
      background: mixHex(primary, "#0a0b10", 0.08),
      surface: mixHex(primary, "#13151c", 0.1),
      sidebar: mixHex(primary, "#0f1117", 0.09),
      text: mixHex(primary, "#f5f6f8", 0.05),
    },
  };
}

/* ---------------- Sinh CSS ---------------- */

/** Danh sách biến CSS của một biến thể, suy ra từ 6 màu gốc */
function variantVars(s: PaletteSeeds, dark: boolean): Record<string, string> {
  const mix = (a: string, pct: number, b: string) => `color-mix(in oklab, ${a} ${pct}%, ${b})`;
  const onPrimary = readableOn(s.primary);
  const ring = mix(s.primary, dark ? 70 : 55, "transparent");
  return {
    "color-scheme": dark ? "dark" : "light",
    "--background": s.background,
    "--foreground": s.text,
    "--card": s.surface,
    "--card-foreground": s.text,
    "--popover": s.surface,
    "--popover-foreground": s.text,
    "--primary": s.primary,
    "--primary-foreground": onPrimary,
    "--brand-2": s.primary2,
    "--secondary": mix(s.text, dark ? 8 : 5, s.surface),
    "--secondary-foreground": s.text,
    "--muted": mix(s.text, dark ? 7 : 4, s.background),
    "--muted-foreground": mix(s.text, dark ? 68 : 60, s.background),
    "--subtle-foreground": mix(s.text, dark ? 78 : 68, s.background),
    "--primary-soft": mix(s.primary, dark ? 22 : 12, s.surface),
    "--border-strong": mix(s.text, dark ? 18 : 17, s.surface),
    "--accent": mix(s.primary, dark ? 18 : 10, s.surface),
    "--accent-foreground": mix(s.primary, dark ? 35 : 70, s.text),
    "--border": mix(s.text, dark ? 12 : 11, s.surface),
    "--input": mix(s.text, 16, s.surface),
    "--ring": ring,
    "--sidebar": s.sidebar,
    "--sidebar-foreground": mix(s.text, 85, s.sidebar),
    "--sidebar-primary": s.primary,
    "--sidebar-primary-foreground": onPrimary,
    "--sidebar-accent": mix(s.primary, dark ? 20 : 12, s.sidebar),
    "--sidebar-accent-foreground": mix(s.primary, dark ? 40 : 80, s.text),
    "--sidebar-border": mix(s.text, 9, s.sidebar),
    "--sidebar-ring": ring,
    ...statusVars(s, dark),
  };
}

/** Biến màu nút / badge: chỉ ghi đè những màu bảng màu có đặt, còn lại giữ mặc định của globals.css */
function statusVars(s: PaletteSeeds, dark: boolean): Record<string, string> {
  const soft = (c: string) => `color-mix(in oklab, ${c} ${dark ? 14 : 12}%, ${s.surface})`;
  const vars: Record<string, string> = {};
  if (s.action) Object.assign(vars, { "--action": s.action, "--action-foreground": readableOn(s.action) });
  if (s.success) Object.assign(vars, { "--success": s.success, "--success-soft": soft(s.success) });
  if (s.info) Object.assign(vars, { "--info": s.info, "--info-soft": soft(s.info) });
  if (s.warning) Object.assign(vars, { "--warning": s.warning, "--warning-soft": soft(s.warning) });
  if (s.danger) Object.assign(vars, { "--destructive": s.danger, "--danger-soft": soft(s.danger) });
  return vars;
}

const block = (selector: string, vars: Record<string, string>) =>
  `${selector}{${Object.entries(vars)
    .map(([k, v]) => `${k}:${v}`)
    .join(";")}}`;

/**
 * CSS ghi đè biến màu cho một bảng màu.
 * Selector có độ ưu tiên (0,2,1) cao hơn `:root` / `.dark` trong globals.css nên luôn thắng bất kể thứ tự chèn.
 */
export function paletteCss(p: Palette) {
  const radius = { "--radius": `${p.radius}rem` };
  return [block("html:root:not(.dark)", { ...variantVars(p.light, false), ...radius }), block("html:root.dark", { ...variantVars(p.dark, true), ...radius })].join("\n");
}

/* ---------------- Lưu trữ ---------------- */

/** Kiểm tra / làm sạch một bảng màu đọc từ localStorage hoặc mã chia sẻ */
export function sanitizePalette(raw: unknown): Palette | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<Palette>;
  const seeds = (v: unknown): PaletteSeeds | null => {
    if (!v || typeof v !== "object") return null;
    const o = v as Record<string, unknown>;
    const keys: (keyof PaletteSeeds)[] = ["primary", "primary2", "background", "surface", "sidebar", "text"];
    if (!keys.every((k) => isHex(o[k]))) return null;
    // màu nút / badge không bắt buộc: chỉ giữ mã hex hợp lệ
    const all = [...keys, ...STATUS_KEYS.filter((k) => isHex(o[k]))];
    return Object.fromEntries(all.map((k) => [k, (o[k] as string).toLowerCase()])) as PaletteSeeds;
  };
  const light = seeds(r.light);
  const dark = seeds(r.dark);
  if (!light || !dark) return null;
  const radius = typeof r.radius === "number" && r.radius >= 0 && r.radius <= 1.6 ? r.radius : DEFAULT_RADIUS;
  const name = typeof r.name === "string" && r.name.trim() ? r.name.trim().slice(0, 40) : "Bảng màu của tôi";
  const id = typeof r.id === "string" && r.id.startsWith("custom-") ? r.id : newCustomId();
  return { id, name, light, dark, radius };
}

/** id cho bảng màu tự phối */
export function newCustomId() {
  return `custom-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Đọc lựa chọn đã lưu (an toàn khi localStorage bị chặn) */
export function loadPaletteState(): PaletteState {
  try {
    const raw = JSON.parse(localStorage.getItem(PALETTE_STORAGE_KEY) || "null") as Partial<PaletteState> | null;
    const customs = Array.isArray(raw?.customs) ? raw.customs.map(sanitizePalette).filter((p): p is Palette => !!p).slice(0, MAX_CUSTOM_PALETTES) : [];
    const activeId = typeof raw?.activeId === "string" ? raw.activeId : DEFAULT_PALETTE_ID;
    return { activeId, customs };
  } catch {
    return { activeId: DEFAULT_PALETTE_ID, customs: [] };
  }
}

/** Tìm bảng màu theo id trong mẫu có sẵn + bảng tự phối (không thấy thì về mặc định) */
export function findPalette(state: PaletteState, id = state.activeId): Palette {
  return PRESET_PALETTES.find((p) => p.id === id) ?? state.customs.find((p) => p.id === id) ?? PRESET_PALETTES[0];
}

/** CSS cần chèn cho bảng màu: mẫu mặc định giữ nguyên màu gốc trong globals.css nên trả chuỗi rỗng */
export function cssFor(p: Palette) {
  return p.id === DEFAULT_PALETTE_ID ? "" : paletteCss(p);
}

/** Lưu lựa chọn + CSS sinh sẵn cho script đầu trang */
export function savePaletteState(state: PaletteState) {
  try {
    localStorage.setItem(PALETTE_STORAGE_KEY, JSON.stringify(state));
    const css = cssFor(findPalette(state));
    if (css) localStorage.setItem(PALETTE_CSS_KEY, css);
    else localStorage.removeItem(PALETTE_CSS_KEY);
  } catch {
    // trình duyệt chặn lưu trữ (chế độ ẩn danh...) -> chỉ áp dụng trong phiên hiện tại
  }
}

/** Mã chia sẻ bảng màu (base64 của JSON) để khách gửi cho nhau / dán lại */
export function encodePalette(p: Palette) {
  const json = JSON.stringify({ name: p.name, light: p.light, dark: p.dark, radius: p.radius });
  return btoa(unescape(encodeURIComponent(json)));
}

/** Giải mã chia sẻ; sai định dạng trả null */
export function decodePalette(code: string): Palette | null {
  try {
    const json = decodeURIComponent(escape(atob(code.trim())));
    const p = sanitizePalette(JSON.parse(json));
    return p ? { ...p, id: newCustomId() } : null;
  } catch {
    return null;
  }
}

/**
 * Script chạy trong <head> trước khi vẽ trang: chèn CSS bảng màu đã lưu để không bị nháy màu mặc định.
 * Viết dạng chuỗi vì được nhúng thẳng vào HTML.
 */
export const PALETTE_BOOT_SCRIPT = `try{var c=localStorage.getItem(${JSON.stringify(PALETTE_CSS_KEY)});if(c){var s=document.createElement("style");s.id=${JSON.stringify(PALETTE_STYLE_ID)};s.textContent=c;document.head.appendChild(s)}}catch(e){}`;
