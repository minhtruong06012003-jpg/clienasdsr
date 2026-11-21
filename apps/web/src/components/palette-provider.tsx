"use client";

/**
 * Quản lý bảng phối màu đang dùng: đọc/lưu localStorage, chèn CSS biến màu vào thẻ <style id="smm-palette">.
 * Hỗ trợ "xem thử" (preview) khi khách đang tự phối màu: áp dụng tạm cho cả site, rời trang là trả về bảng đã lưu.
 * Bảng phối màu chỉ lưu trên trình duyệt của khách (localStorage).
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  DEFAULT_PALETTE_ID,
  MAX_CUSTOM_PALETTES,
  PALETTE_STORAGE_KEY,
  PALETTE_STYLE_ID,
  cssFor,
  findPalette,
  loadPaletteState,
  paletteCss,
  savePaletteState,
  sanitizePalette,
  type Palette,
  type PaletteState,
} from "@/lib/palette";

type PaletteContextValue = {
  /** đã đọc xong localStorage (trước đó đang render ở server / lần đầu) */
  ready: boolean;
  activeId: string;
  active: Palette;
  customs: Palette[];
  /** chọn bảng màu (mẫu có sẵn hoặc tự phối) */
  select: (id: string) => void;
  /** thêm mới / cập nhật bảng tự phối, tuỳ chọn áp dụng luôn */
  saveCustom: (p: Palette, apply?: boolean) => boolean;
  removeCustom: (id: string) => void;
  /** áp dụng tạm một bảng màu (null = trả về bảng đang lưu) */
  preview: (p: Palette | null) => void;
  /** toàn bộ lựa chọn đang lưu (để đồng bộ lên tài khoản) */
  state: PaletteState;
  /** thay toàn bộ lựa chọn (vd. bản lấy từ tài khoản), có làm sạch dữ liệu */
  replaceState: (next: PaletteState) => void;
};

const PaletteContext = createContext<PaletteContextValue | null>(null);

/** Ghi CSS vào thẻ <style> (tạo mới nếu script đầu trang chưa tạo) */
function writeStyle(css: string) {
  let el = document.getElementById(PALETTE_STYLE_ID) as HTMLStyleElement | null;
  if (!css) {
    el?.remove();
    return;
  }
  if (!el) {
    el = document.createElement("style");
    el.id = PALETTE_STYLE_ID;
    document.head.appendChild(el);
  }
  if (el.textContent !== css) el.textContent = css;
}

export function PaletteProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<PaletteState>({ activeId: DEFAULT_PALETTE_ID, customs: [] });
  const [ready, setReady] = useState(false);
  const [draft, setDraft] = useState<Palette | null>(null);

  // đọc lựa chọn đã lưu sau khi mount; đồng bộ khi khách đổi bảng màu ở tab khác
  useEffect(() => {
    setState(loadPaletteState());
    setReady(true);
    const onStorage = (e: StorageEvent) => {
      if (e.key === PALETTE_STORAGE_KEY) setState(loadPaletteState());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const active = useMemo(() => findPalette(state), [state]);

  // chèn CSS: ưu tiên bản xem thử, không thì bảng màu đang lưu (chờ đọc xong để không xoá CSS của script đầu trang)
  useEffect(() => {
    if (!ready) return;
    writeStyle(draft ? paletteCss(draft) : cssFor(active));
  }, [ready, draft, active]);

  /** Cập nhật state + lưu localStorage cùng lúc */
  const commit = useCallback((updater: (s: PaletteState) => PaletteState) => {
    setState((prev) => {
      const next = updater(prev);
      savePaletteState(next);
      return next;
    });
  }, []);

  const select = useCallback((id: string) => commit((s) => ({ ...s, activeId: id })), [commit]);

  const saveCustom = useCallback(
    (p: Palette, apply = true) => {
      const current = loadPaletteState();
      const exists = current.customs.some((c) => c.id === p.id);
      if (!exists && current.customs.length >= MAX_CUSTOM_PALETTES) return false;
      commit((s) => ({
        activeId: apply ? p.id : s.activeId,
        customs: s.customs.some((c) => c.id === p.id) ? s.customs.map((c) => (c.id === p.id ? p : c)) : [...s.customs, p],
      }));
      return true;
    },
    [commit],
  );

  // xoá bảng tự phối; nếu đang dùng thì quay về mặc định
  const removeCustom = useCallback(
    (id: string) => commit((s) => ({ activeId: s.activeId === id ? DEFAULT_PALETTE_ID : s.activeId, customs: s.customs.filter((c) => c.id !== id) })),
    [commit],
  );

  const replaceState = useCallback(
    (next: PaletteState) =>
      commit(() => ({
        activeId: typeof next.activeId === "string" ? next.activeId : DEFAULT_PALETTE_ID,
        customs: (Array.isArray(next.customs) ? next.customs : []).map(sanitizePalette).filter((p): p is Palette => !!p).slice(0, MAX_CUSTOM_PALETTES),
      })),
    [commit],
  );

  const value = useMemo<PaletteContextValue>(
    () => ({ ready, activeId: active.id, active, customs: state.customs, select, saveCustom, removeCustom, preview: setDraft, state, replaceState }),
    [ready, active, state, select, saveCustom, removeCustom, replaceState],
  );

  return <PaletteContext.Provider value={value}>{children}</PaletteContext.Provider>;
}

/** Dùng trong component để đọc / đổi bảng màu */
export function usePalette() {
  const ctx = useContext(PaletteContext);
  if (!ctx) throw new Error("usePalette phải dùng bên trong <PaletteProvider>");
  return ctx;
}
