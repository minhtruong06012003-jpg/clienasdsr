'use client';

/**
 * Các tab Cài đặt của AI Studio:
 * - AiProvidersTab: (dùng ở trang AI Studio › Công cụ AI, tab Khoá API) khoá API + URL gốc của từng nhà cung cấp AI (nhóm `ai_<key>`, apiKey được API che "••••••••"),
 *   kèm tỉ giá quy đổi `rate`: 1 credit / xu nguồn = bao nhiêu đồng (VND) (giá công cụ "theo chi phí NCC" = chi phí × tỉ giá, cộng % lãi).
 * - CreditsTab: tiền (VND) tặng vào ví khi đăng ký, số luồng chạy cùng lúc, nạp tiền vào ví theo số tiền tự do (tỉ lệ, hạn mức, mức gợi ý,
 *   mốc khuyến mãi, chương trình khuyến mãi có thời hạn — khoá `topup`), quyền lợi chung + ghi chú dưới bảng giá (nhóm `credits`).
 * - AiGeneralTab: chu kỳ hỏi trạng thái, thời gian tối đa, dung lượng file tải lên, sao lưu kết quả, tự xoá tác vụ cũ (nhóm `ai`).
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Film, Loader2, Plus, Trash2, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Field, Section } from '@/components/common/field';
import { NumberInput } from '@/components/common/number-input';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { SecretInput, SwitchRow } from './inputs';
import { SettingsGroup } from './settings-group';

/** Nhà cung cấp AI đã tích hợp (khớp AI_PROVIDERS ở API) + gợi ý lấy khoá */
export interface AiProviderMetaItem {
  key: string;
  name: string;
  hint: string;
  extra?: { name: string; label: string; help: string }[];
}

export const AI_PROVIDER_META: AiProviderMetaItem[] = [
  { key: 'tmc', name: 'TMC Video AI', hint: 'Khoá dạng tmc_live_… — lấy ở tài khoản tmcvideoai.net. Đơn vị tính: xu.' },
  { key: 'kapend', name: 'Kapend', hint: 'Khoá dạng sk_kp_… ở kapend.com › Tài khoản › Developer. API ảnh / video cần gói Pro trở lên.' },
  {
    key: 'aideepcut',
    name: 'AI DeepCut',
    hint: 'Khoá adc_live_… (VIP) hoặc adc_test_… (sandbox, trả kết quả mẫu miễn phí để thử tích hợp). Mỗi model AI DeepCut là một công cụ, danh mục gắn sẵn trong code.',
  },
  { key: 'imgstudio', name: 'IMG Studio', hint: 'Khoá img_… tạo ở imgstudio.site/account (cần tài khoản đã nạp tiền). Tiền trừ vào ví IMG Studio theo giá từng model.' },
  {
    key: 'ahiep',
    name: 'AHiep API (api.ahiep.com)',
    hint: 'Khoá sk-… do nhà cung cấp cấp; số dư / lịch sử xem ở api.ahiep.com/my-usage. Nhập giá vốn ảnh và video bên dưới.',
  },
  {
    key: 'tavtavvideo',
    name: 'tavtavvideo',
    hint: 'Khoá kết nối mc_live_… khớp với Motion API Key trên ứng dụng Client. Giá bán 3 tính năng (Motion Control 720p, 1080p, 4K) đặt tự do trực tiếp ở tab Công cụ.',
  },
  {
    key: 'runup',
    name: 'Runup Studio (runup.studio)',
    hint: 'Khoá rup_live_… tạo ở API Console của runup.studio (cần gói Pro / Founder). Làm nét video 4K tính 3 UP mỗi giây video gốc, 1 UP = 10đ: tỉ giá quy đổi mặc định 10.',
  },
  {
    key: 'fable',
    name: 'Fable Studio · Grok Pool (fablemedical.shop)',
    hint: 'Khoá fm-… lấy sau khi thuê gói ngày / tuần tại fablemedical.shop (63.000đ/ngày/luồng, không giới hạn lượt Grok Video 1.5 1080p & Grok Image 2.0 2K). Hệ thống đã tích hợp sẵn hàng đợi tự chờ luồng trống khi vượt luồng (429) và tự sao lưu MP4/ảnh 2K về máy chủ. Giá bán lẻ từng model chỉnh ở tab Công cụ.',
  },
  {
    key: 'up4k',
    name: 'Up4K · Nâng cấp Video 4K (up4k.io)',
    hint: 'Khoá cx_live_… lấy tại up4k.io › Tài khoản › API (mở sau 1 đơn nạp từ 199.000đ). Hỗ trợ đủ 3 chế độ 4K Fast (đồng giá 1 credit cho video ≤ 35s, nhận tới 60 phút), 4K Pro (4,5s = 1 credit, trừ lẻ 0,1 credit) và 4K Max (2,5s = 1 credit). Tỉ giá mặc định đặt mức an toàn 1 credit = 2.620đ (khớp giá gốc không ưu đãi của gói nhỏ nhất 199k/76cr = 2.618đ, cộng sẵn +38% lãi ở từng công cụ; nếu nạp gói lớn 499k/999k hoặc giá đại lý thì lời thêm sâu hơn).',
  },
  {
    key: 'ivoi',
    name: 'iVoi · Giọng nói AI & Nhân bản giọng (ivoi.io)',
    hint: 'Khoá API lấy tại ivoi.io/app/api (mục Tạo API Key). Tự động đồng bộ danh sách toàn bộ giọng đọc tiếng Việt & đa ngôn ngữ kèm nghe thử 1 chạm, hỗ trợ Chuyển văn bản thành giọng nói (tới 100.000 ký tự/lượt, tuỳ chỉnh tốc độ & ngắt nghỉ dấu câu) và Nhân bản giọng nói AI từ file mẫu (tự động xoá giọng tạm sau khi xuất file để không tốn hạn mức 10 giọng). Tỉ giá mặc định đặt mức an toàn 1 nghìn token = 500đ (khớp gói lẻ nhỏ nhất BASIC 499k / 1 triệu token = 499đ; nạp gói CREATOR 349đ, PRO 254đ, BUSINESS 149đ sẽ lời thêm sâu hơn), cộng sẵn +38% lãi ở từng công cụ.',
  },
  {
    key: 'tramsangtao',
    name: 'Trạm Sáng Tạo · Video, KOL AI & Motion (tramsangtao.com)',
    hint: 'Khoá sk_live_… lấy tại tramsangtao.com/developers/keys. Hỗ trợ Kling Avatar 2.0, Kling 2.5 Turbo, Wan 3.0, Seedance 2.0 Mini / Fast, Motion Control 2.6 / 3.0… Giá credit đọc trực tiếp từ /v1/models. Tỉ giá gốc mặc định đặt chuẩn gói Starter 99.000đ / 2.000 credit = 49,5đ/credit (nếu nạp gói lớn hơn sẽ lời thêm sâu hơn), cộng sẵn % lãi ở từng công cụ.',
  },
  {
    key: 'gommo',
    name: '79AI · GoMMO Gateway (79ai.net · SV13)',
    hint: 'API Token tạo tại 79ai.net/settings/tokens (cổng gốc v2.api.gommo.net). Hỗ trợ Gemini Omni Flash 1.2 4K, Seedance 2.0 Omni / 2.0 / Mini, Wan 3.0, Kling 2.5 Relax, Meta Muse 1.0, Veo 3.1 Lite/Fast, Kling LipSync, HeyGen Video, Genjutsu Lite, Suno 6.0/5.5, Seedream 5.5, GPT Image 2.6 & Ideogram 4.5. Tỉ giá gốc mặc định đặt mốc an toàn 1 credit = 1,05đ (khớp gói lẻ START 100.000đ + 5% VAT = 105.000đ / 100.000 credit; nếu nâng lên gói PLUS 0,9975đ/cr, PREMIUM 0,945đ/cr hoặc ULTRA 0,8925đ/cr thì lời thêm sâu hơn hoặc đổi nhanh ngay trên thẻ), cộng sẵn +28% lãi ở từng công cụ.',
    extra: [{ name: 'domain', label: 'Tên miền ứng dụng (Domain)', help: 'Mặc định 79ai.net — khớp với domain gắn trên API Token GoMMO' }],
  },
  {
    key: 'botsd',
    name: 'BotSD · Seedance 2.5, Seedance 2.0 & Seedream 5.5 (botsd.pro · SV14)',
    hint: 'Ô Khoá API nhập dạng tài_khoản:mật_khẩu (ví dụ user:pass) hoặc mã clientToken lấy từ botsd.pro — hệ thống tự động đăng nhập giữ phiên, hỗ trợ Seedance 2.5 (720p/1080p/Flash 480p), Seedance 2.0, Muse AI & Tạo ảnh Seedream 5.5 (1.5K = 1P, 2K = 2P, tới 10 ảnh tham chiếu), tải thẳng file MP4/ảnh về máy chủ và đồng bộ bảo trì 2 chiều. Tỉ giá gốc mặc định đặt mức an toàn 1 Point = 454,55đ (khớp gói lẻ nhỏ nhất 50k / 110P; nếu nạp gói 500k = 416,7đ/P, 1tr = 384,6đ/P, 2tr = 363,6đ/P thì lãi thực tế còn cao hơn hoặc chỉnh tại đây), cộng sẵn +28% lãi ở từng công cụ.',
  },
  {
    key: 'maivideo',
    name: 'MaiVideo Studio · MiniMax H3, Wan 3.0, Seedance 2.0 & GPT Image 2.5 (maivideo.top · SV15)',
    hint: 'Khoá API dạng sk_live_… lấy tại maivideo.top/member?tab=account. Hỗ trợ MiniMax H3 2K, Wan 3.0 1080p tới 30s có tiếng, Seedance 2.0 Fast, PixVerse V6/V5.6/C1, GPT Image 2.5 Pro/Fast 4K tách nền, Nano Banana 2.1/Pro/2 4K, Seedream 5.5 và Giọng đọc AI đa ngôn ngữ. Tỉ giá gốc mặc định: 1 credit = 1.000đ (không tính khuyến mãi nạp), cộng sẵn +35% lãi ở toàn bộ công cụ và tự tải file về máy chủ.',
  },
  {
    key: 'aishop24',
    name: 'AIShop24 Studio · Seedance 2.5, Seedance 2.5 Flash & 2.0 Mini (aishop24.io.vn · SV16)',
    hint: 'Khoá API dạng sk-as24-… lấy tại aishop24.io.vn/profile.html#api-key. Chuyên nhánh Seedance 2.5 & Seedance 2.5 Flash dài tới 30 giây (480p / 720p / 1080p, đa tham chiếu ảnh/video/audio) và Seedance 2.0 Mini giá tốt. Tỉ giá gốc mặc định: 1 credit = 95đ (nếu lên gói Creator 86,2đ/cr hoặc Ultra 82,7đ/cr thì biên lãi tự cao hơn), cộng sẵn +28% lãi ở công cụ và tự tải video về máy chủ.',
  },
  {
    key: 'plenxai',
    name: 'PlenxAI Developer · Veo 3.1, Omni Flash 1.2, Seedance 2.5 Flash, FLUX 3 & Grok (plenxai.com · SV17)',
    hint: 'Khoá Developer API dạng pk_… tạo tại plenxai.com/docs. Bật sẵn sản phẩm giá tốt (Veo 3/3.1 Relaxed/Lite/Fast, Omni Flash 1.0/1.2, Seedance 2.5 Flash tới 30s, FLUX 3 Video, Grok Video 1.5, MiniMax H3 768p/1080p, Grok Image, Nano Banana PRO/2, Kling 3.0 Omni Image, GPT Image 2.6, Xoá nền AI miễn phí). Để tự đồng bộ trực tiếp số dư từ web nguồn, có thể dán refresh_token hoặc tài_khoản:mật_khẩu plenxai.com vào ô Token phiên web; nếu để trống, hệ thống hỗ trợ nhập nhanh số credit hiện có và tự trừ lùi theo từng đơn chạy.',
  },
  {
    key: 'seedancebot',
    name: 'Seedance Studio · Seedance 2.5 / 2.5 Flash tới 30s & 30 ảnh tham chiếu (seedancecreationbot.online · SV18)',
    hint: 'Khoá API dạng sk-… tạo bằng lệnh /api new trên bot SeedanceCreationBot. Đấu nối đầy đủ 16 sản phẩm (bật sẵn Seedance 2.5 & Seedance 2.5 Flash Tiêu chuẩn 480p–1080p dài 4–30s hỗ trợ tới 30 ảnh + 30s video tham chiếu, các gói giá cao hơn để ở chế độ tắt cho bộ lọc Nhận định giá tự theo dõi). Đơn vị ví gốc tính trực tiếp bằng VNĐ (tỉ giá mặc định = 1), hỗ trợ đọc số dư tự động GET /v1/me, huỷ đơn DELETE hoàn ví tự động và tải file MP4/PNG thẳng về máy chủ.',
  },
];

export function AiProvidersTab({ onSaved }: { onSaved?: () => void }) {
  // đơn vị chi phí + tỉ giá mặc định của từng adapter (cùng query với trang Công cụ AI nên dùng chung cache)
  const tools = useQuery({ queryKey: ['ai-tools'], queryFn: () => api.get<{ providers: { key: string; costUnit: string | null; defaultRate: number | null }[] }>('/admin/ai/tools') });
  const meta = (k: string) => tools.data?.providers.find((x) => x.key === k);
  return (
    <div className="space-y-8">
      <p className="text-sm text-muted-foreground">
        Khoá API chỉ lưu trong cơ sở dữ liệu (không nằm trong mã nguồn) và luôn được che khi xem lại. Bật nhà cung cấp nào thì công cụ của nhà cung cấp đó hiện cho khách; giá (VND) từng công cụ chỉnh ở tab Công cụ.
      </p>
      {AI_PROVIDER_META.map((p) => (
        <SettingsGroup key={p.key} group={`ai_${p.key}`} onSaved={onSaved}>
          {(v, set) => (
            <Section title={p.name} description={p.hint}>
              <SwitchRow label="Bật nhà cung cấp" description="Tắt thì các công cụ của nhà cung cấp này bị ẩn với khách" checked={v.enabled === true} onChange={(enabled) => set({ enabled })} />
              {/* bật thì API đồng bộ tên công cụ + tên model theo nhà cung cấp mỗi lần lưu / khởi động (ghi đè tên đã sửa tay) */}
              <SwitchRow
                label="Tự cập nhật tên công cụ"
                description="Mặc định Bật: tự động cập nhật tên công cụ & model từ nguồn; nếu tên dính ký tự / thương hiệu / tên miền của nguồn thì hệ thống tự lọc bỏ sạch trước khi đưa lên web."
                checked={v.autoName !== false}
                onChange={(autoName) => set({ autoName })}
              />
              <div className="grid gap-4 md:grid-cols-2">
                <Field label="Khoá API">
                  <SecretInput value={v.apiKey as string} onChange={(apiKey) => set({ apiKey })} placeholder="Dán khoá API" />
                </Field>
                <Field label="URL gốc API" help="Giữ mặc định trừ khi nhà cung cấp đổi địa chỉ">
                  <Input value={(v.baseUrl as string) ?? ''} onChange={(e) => set({ baseUrl: e.target.value.trim() })} />
                </Field>
                {/* chỉ nhà cung cấp có công cụ tính giá theo chi phí NCC mới có đơn vị chi phí -> mới cần tỉ giá */}
                {meta(p.key)?.costUnit && (
                  <Field
                    label={`Tỉ giá quy đổi: 1 ${meta(p.key)?.costUnit} = ? đ`}
                    help={`Giá khách trả = chi phí nhà cung cấp × tỉ giá, rồi cộng % lãi của từng công cụ. Để trống = mặc định ${(meta(p.key)?.defaultRate ?? 1).toLocaleString('vi-VN')}`}
                  >
                    <NumberInput
                      suffix="đ"
                      min={0}
                      value={(v.rate as number) ?? null}
                      placeholder={String(meta(p.key)?.defaultRate ?? 1)}
                      onChange={(rate) => set({ rate: rate && rate > 0 ? rate : null })}
                    />
                  </Field>
                )}
                {p.extra?.map((x) => (
                  <Field key={x.name} label={x.label} help={x.help}>
                    <Input value={(v[x.name] as string) ?? ''} onChange={(e) => set({ [x.name]: e.target.value.trim() })} />
                  </Field>
                ))}
              </div>
              {p.key === 'ahiep' && <AhiepCosts v={v} set={set} />}
            </Section>
          )}
        </SettingsGroup>
      ))}
    </div>
  );
}

/** Ô nhập giá vốn theo từng model (đ), để trống = giá mặc định của API */
function CostGrid({ title, help, suffix, value, onChange }: { title: string; help: string; suffix: string; value: Record<string, number>; onChange: (v: Record<string, number>) => void }) {
  return (
    <div className="space-y-2">
      <div>
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs text-muted-foreground">{help}</p>
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        {Object.keys(value).map((model) => (
          <Field key={model} label={model}>
            <NumberInput suffix={suffix} min={0} value={value[model] ?? null} onChange={(n) => onChange({ ...value, [model]: n && n > 0 ? n : 0 })} />
          </Field>
        ))}
      </div>
    </div>
  );
}

/**
 * Bảng giá vốn AHiep (nhóm `ai_ahiep`): đ / 1 triệu token theo model chat, đ / ảnh theo model ảnh, đ / mỗi video.
 * Giá bán cho khách = giá vốn × (1 + % lãi của từng công cụ ở tab Công cụ), không thấp hơn mức tối thiểu.
 * Khách bị trừ trước theo độ dài TỐI ĐA (ký tự nhập + lời nhắc hệ thống + độ dài kết quả tối đa) nên không bị lỗ khi AI viết dài.
 */
export function AhiepCosts({ v, set }: { v: Record<string, unknown>; set: (patch: Record<string, unknown>) => void }) {
  const imageCosts = (v.imageCosts as Record<string, number>) ?? {};
  return (
    <div className="space-y-6 rounded-lg border p-4">
      <p className="text-sm text-muted-foreground">
        Giá vốn là số tiền nguồn API trừ của bạn. Giá bán cho khách = giá vốn × (1 + % tăng giá), không thấp hơn mức tối thiểu; có thể đối chiếu giá vốn thực tế trong chi tiết tác vụ (usage) để chỉnh cho sát.
      </p>
      <CostGrid title="Tạo / sửa ảnh" help="đ giá vốn cho mỗi ảnh" suffix="đ" value={imageCosts} onChange={(imageCosts) => set({ imageCosts })} />
      <Field label="Video muse-video" help="đ giá vốn cho mỗi video (không phụ thuộc thời lượng)">
        <NumberInput suffix="đ/video" min={0} value={(v.videoCostPerVideo as number) ?? null} onChange={(n) => set({ videoCostPerVideo: n && n > 0 ? n : 0 })} />
      </Field>
    </div>
  );
}

export function CreditsTab() {
  const { can } = useAuth();
  const tiersOnly = !can('*');
  return (
    <SettingsGroup group="credits">
      {(v, set) =>
        tiersOnly ? (
          <TopupSection tiersOnly value={(v.topup as Partial<TopupConfig>) ?? {}} onChange={(topup) => set({ topup })} />
        ) : (
          <>
            <Section title="Số dư ví & đăng ký" description="Số dư ví (VND) là tiền khách dùng để chạy công cụ AI. Khách tự nhập số tiền muốn nạp ở trang Bảng giá, thanh toán qua cổng QR hoặc số dư ví.">
              <div className="grid gap-4 md:grid-cols-2">
                <Field label="Tặng khi đăng ký" help="Số tiền cộng vào ví cho mỗi tài khoản mới, 0 = không tặng">
                  <NumberInput integer suffix="đ" value={(v.signupBonus as number) ?? 0} onChange={(n) => set({ signupBonus: Math.max(0, n ?? 0) })} />
                </Field>
                <Field label="Số luồng chạy cùng lúc" help="Số tác vụ AI một khách được chạy cùng lúc (khách còn gói cước cũ thì theo gói tới khi hết hạn)">
                  <NumberInput integer value={(v.defaultConcurrency as number) ?? 1} onChange={(n) => set({ defaultConcurrency: Math.max(1, n ?? 1) })} />
                </Field>
              </div>
            </Section>
            <TopupSection value={(v.topup as Partial<TopupConfig>) ?? {}} onChange={(topup) => set({ topup })} />
            {/* khung quyền lợi chung dưới ô nạp tiền ở trang Bảng giá website (API: credits.service.ts › publicPlans) */}
            <Section title="Quyền lợi chung dưới bảng giá" description="Hiện trong khung quyền lợi chung dưới ô nạp tiền ở trang Bảng giá của website.">
              <div className="grid gap-4">
                <Field label="Quyền lợi" help="Mỗi dòng một quyền lợi, để trống = ẩn khung">
                  <Textarea
                    rows={8}
                    value={((v.packFeatures as string[]) ?? []).join('\n')}
                    onChange={(e) => set({ packFeatures: e.target.value.split('\n') })}
                  />
                </Field>
                <Field label="Ghi chú cuối khung" help="vd: Nếu gặp vấn đề về thanh toán, vui lòng liên hệ Telegram @...">
                  <Input value={(v.packNote as string) ?? ''} onChange={(e) => set({ packNote: e.target.value })} />
                </Field>
              </div>
            </Section>
          </>
        )
      }
    </SettingsGroup>
  );
}

/** Cấu hình nạp tiền vào ví (khớp TopupSettings ở API: credits.settings.ts) */
interface TopupConfig {
  rate: number;
  min: number;
  max: number;
  presets: number[];
  tiers: { min: number; bonus: number }[];
  promo: { enabled: boolean; bonus: number; label: string; startsAt: string; endsAt: string };
}

const TOPUP_FALLBACK: TopupConfig = {
  rate: 1,
  min: 10000,
  max: 100000000,
  presets: [],
  tiers: [],
  promo: { enabled: false, bonus: 10, label: 'Khuyến mãi', startsAt: '', endsAt: '' },
};

const vnd = (n: number) => n.toLocaleString('vi-VN');

/** ISO -> giá trị ô datetime-local (giờ máy admin) và ngược lại; rỗng = không giới hạn */
const toLocalInput = (iso: string) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};
const fromLocalInput = (v: string) => (v ? new Date(v).toISOString() : '');

/**
 * Nạp tiền vào ví theo số tiền tự do: tỉ lệ (đ nhận được cho mỗi 1đ trả), hạn mức, mức gợi ý, mốc khuyến mãi theo số tiền (nạp càng nhiều tặng càng nhiều)
 * và chương trình khuyến mãi có thời hạn (cộng dồn với mốc). Website tính số tiền nhận vào ví ngay khi khách gõ số tiền.
 */
function TopupSection({ value, onChange, tiersOnly = false }: { value: Partial<TopupConfig>; onChange: (v: TopupConfig) => void; tiersOnly?: boolean }) {
  const c: TopupConfig = { ...TOPUP_FALLBACK, ...value, promo: { ...TOPUP_FALLBACK.promo, ...(value.promo ?? {}) } };
  const set = (patch: Partial<TopupConfig>) => onChange({ ...c, ...patch });
  const setPromo = (patch: Partial<TopupConfig['promo']>) => set({ promo: { ...c.promo, ...patch } });
  const setTier = (i: number, patch: Partial<TopupConfig['tiers'][number]>) => set({ tiers: c.tiers.map((t, j) => (j === i ? { ...t, ...patch } : t)) });
  // ví dụ quy đổi cho admin dễ hình dung (mốc cao nhất đạt được + khuyến mãi nếu đang bật)
  const sample = 1_000_000;
  const tier = [...c.tiers].sort((a, b) => b.min - a.min).find((t) => sample >= t.min)?.bonus ?? 0;
  const promo = c.promo.enabled ? c.promo.bonus : 0;
  const base = Math.floor(sample * (c.rate || 0));
  const total = base + Math.floor((base * (tier + promo)) / 100);

  const tiersCard = (
    <Section title="Khuyến mãi theo mốc nạp" description="Nạp từ mốc nào trở lên được tặng thêm % tiền nạp của mốc cao nhất đạt được. Để trống = không tặng.">
      <div className="space-y-2">
        {c.tiers.map((t, i) => (
          <div key={i} className="flex items-center gap-2">
            <span className="w-16 shrink-0 text-xs text-muted-foreground">Nạp từ</span>
            <NumberInput integer suffix="đ" className="flex-1" value={t.min} onChange={(n) => setTier(i, { min: Math.max(0, n ?? 0) })} />
            <span className="shrink-0 text-xs text-muted-foreground">tặng</span>
            <NumberInput step={0.5} suffix="%" className="w-28" value={t.bonus} onChange={(n) => setTier(i, { bonus: Math.min(100, Math.max(0, n ?? 0)) })} />
            <Button type="button" variant="ghost" size="icon" onClick={() => set({ tiers: c.tiers.filter((_, j) => j !== i) })} aria-label="Xoá mốc">
              <Trash2 className="size-4" />
            </Button>
          </div>
        ))}
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            const last = c.tiers[c.tiers.length - 1];
            set({ tiers: [...c.tiers, { min: last ? last.min * 2 : 50000, bonus: last ? last.bonus + 5 : 5 }] });
          }}
        >
          <Plus className="size-4" /> Thêm mốc
        </Button>
      </div>
    </Section>
  );

  if (tiersOnly) return tiersCard;

  return (
    <>
      <Section title="Nạp tiền vào ví" description="Khách nhập số tiền bất kỳ trong hạn mức, số tiền nhận vào ví = số tiền trả × tỉ lệ, cộng thêm % khuyến mãi theo mốc và chương trình đang chạy.">
        <div className="grid gap-4 md:grid-cols-3">
          <Field label="Tỉ lệ quy đổi" help="Số đồng nhận vào ví cho mỗi 1đ khách trả (1 = trả 100.000đ nhận 100.000đ)">
            <NumberInput step={0.01} suffix="đ/đ" value={c.rate} onChange={(n) => set({ rate: Math.max(0.0001, n ?? 1) })} />
          </Field>
          <Field label="Nạp tối thiểu">
            <NumberInput integer suffix="đ" value={c.min} onChange={(n) => set({ min: Math.max(1000, n ?? 10000) })} />
          </Field>
          <Field label="Nạp tối đa">
            <NumberInput integer suffix="đ" value={c.max} onChange={(n) => set({ max: Math.max(1000, n ?? 100000000) })} />
          </Field>
        </div>
        <Field label="Mức tiền gợi ý" help="Nút chọn nhanh ở trang Bảng giá, cách nhau bằng dấu phẩy (vd 50000, 100000, 500000)">
          <Input
            defaultValue={c.presets.join(', ')}
            key={c.presets.join(',')}
            onBlur={(e) =>
              set({
                presets: e.target.value
                  .split(/[,\s;]+/)
                  .map((x) => Math.round(Number(x.replace(/\./g, ''))))
                  .filter((n) => Number.isFinite(n) && n > 0),
              })
            }
          />
        </Field>
        <p className="rounded-lg bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
          Ví dụ: nạp {vnd(sample)}đ → nhận {vnd(base)}đ vào ví{tier + promo > 0 ? ` + tặng ${tier + promo}% = ${vnd(total)}đ` : ''}.
        </p>
      </Section>

      {tiersCard}

      <Section title="Chương trình khuyến mãi" description="Tặng thêm % tiền nạp cho mọi lần nạp trong thời gian chương trình, cộng dồn với % theo mốc. Website hiện banner + đếm ngược tới lúc kết thúc.">
        <SwitchRow label="Bật chương trình khuyến mãi" checked={c.promo.enabled} onChange={(enabled) => setPromo({ enabled })} />
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Tên chương trình" help="vd: Mừng khai trương, Black Friday">
            <Input value={c.promo.label} onChange={(e) => setPromo({ label: e.target.value })} />
          </Field>
          <Field label="Tặng thêm">
            <NumberInput step={0.5} suffix="%" value={c.promo.bonus} onChange={(n) => setPromo({ bonus: Math.min(100, Math.max(0, n ?? 0)) })} />
          </Field>
          <Field label="Bắt đầu" help="Để trống = bắt đầu ngay">
            <Input type="datetime-local" value={toLocalInput(c.promo.startsAt)} onChange={(e) => setPromo({ startsAt: fromLocalInput(e.target.value) })} />
          </Field>
          <Field label="Kết thúc" help="Để trống = không giới hạn">
            <Input type="datetime-local" value={toLocalInput(c.promo.endsAt)} onChange={(e) => setPromo({ endsAt: fromLocalInput(e.target.value) })} />
          </Field>
        </div>
      </Section>
    </>
  );
}

export function AiGeneralTab() {
  const { can } = useAuth();
  return (
    <SettingsGroup group="ai">
      {(v, set) => (
        <>
          <Section title="Xử lý tác vụ" description="Hệ thống hỏi trạng thái tác vụ ở nhà cung cấp định kỳ; quá thời gian tối đa thì huỷ và hoàn tiền vào ví">
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="Chu kỳ hỏi trạng thái">
                <NumberInput integer suffix="giây" value={(v.pollSeconds as number) ?? 10} onChange={(n) => set({ pollSeconds: Math.max(5, n ?? 10) })} />
              </Field>
              <Field label="Thời gian tối đa một tác vụ">
                <NumberInput integer suffix="phút" value={(v.timeoutMinutes as number) ?? 60} onChange={(n) => set({ timeoutMinutes: Math.max(5, n ?? 60) })} />
              </Field>
            </div>
          </Section>
          <Section title="File">
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="Ảnh / phụ đề khách tải lên tối đa" help="Tối đa 100MB">
                <NumberInput integer suffix="MB" value={(v.maxUploadMb as number) ?? 50} onChange={(n) => set({ maxUploadMb: Math.min(100, Math.max(1, n ?? 50)) })} />
              </Field>
              {/* video / âm thanh ghi ra đĩa tạm nên cho lớn (vd video 60 phút cần lồng tiếng); Nginx cũng phải cho phép mức này */}
              <Field label="Video / âm thanh khách tải lên tối đa" help="Tối đa 1024MB (1GB)">
                <NumberInput integer suffix="MB" value={(v.maxMediaUploadMb as number) ?? 1024} onChange={(n) => set({ maxMediaUploadMb: Math.min(1024, Math.max(1, n ?? 1024)) })} />
              </Field>
              <Field label="Sao lưu kết quả tối đa" help="File lớn hơn giữ link gốc của nhà cung cấp">
                <NumberInput integer suffix="MB" value={(v.mirrorMaxMb as number) ?? 300} onChange={(n) => set({ mirrorMaxMb: Math.max(1, n ?? 300) })} />
              </Field>
            </div>
            <SwitchRow
              label="Sao lưu kết quả về máy chủ"
              description="Tải file kết quả từ nhà cung cấp về storage của website (link nhà cung cấp thường hết hạn sau 7 ngày)"
              checked={v.mirrorOutputs !== false}
              onChange={(mirrorOutputs) => set({ mirrorOutputs })}
            />
          </Section>
          {/* dọn tác vụ cũ mỗi giờ ở phút 45 (API: modules/ai/ai-cleanup.service.ts); lịch sử biến động số dư vẫn được giữ */}
          <Section
            title="Tự động xoá tác vụ cũ"
            description="Tự động xoá tác vụ đã kết thúc (thành công / lỗi / huỷ) cũ hơn thời hạn dưới đây cùng file đầu vào và kết quả trên storage. Lịch sử biến động số dư vẫn được giữ."
          >
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="Giữ tác vụ trong" help="0 = giữ vĩnh viễn; 1 = 24 giờ (1 ngày)">
                <NumberInput
                  integer
                  suffix="ngày"
                  value={(v.taskRetentionDays as number) ?? 0}
                  onChange={(n) => set({ taskRetentionDays: Math.max(0, n ?? 0) })}
                />
              </Field>
            </div>
            <SwitchRow
              label="Giữ lại tác vụ đang công khai"
              description="Không xoá tác vụ khách đang chia sẻ trên trang Cộng đồng"
              checked={v.taskRetentionKeepPublic !== false}
              onChange={(taskRetentionKeepPublic) => set({ taskRetentionKeepPublic })}
            />
          </Section>
          {can('ai.tools') && <DemoVideoManager />}
        </>
      )}
    </SettingsGroup>
  );
}

interface DemoToolRow {
  key: string;
  name: string;
  modelLabel?: string | null;
  enabled: boolean;
  models: number;
  modelGroups: string[];
  demoVideo?: string | null;
}

interface DemoGroupItem {
  id: string;
  isGroup: boolean;
  label: string;
  repKey: string;
  count: number;
  enabled: boolean;
  demoVideo: string | null;
}

/** Quản lý nhanh Video / ảnh mẫu tham khảo theo Nhóm Model ngay trong Cài đặt › AI (1 lần lưu áp dụng cho cả nhóm) */
function DemoVideoManager() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['ai-tools'], queryFn: () => api.get<{ tools: DemoToolRow[] }>('/admin/ai/tools') });
  const [search, setSearch] = useState('');

  // Gom các model theo đúng Nhóm model (không liệt kê từng sản phẩm con trong nhóm); công cụ đứng lẻ không thuộc nhóm nào thì giữ nguyên 1 mục
  const allItems: DemoGroupItem[] = (() => {
    const raw = (q.data?.tools ?? []).filter((t) => t.models === 0);
    const groupMap = new Map<string, DemoToolRow[]>();
    const singles: DemoToolRow[] = [];
    for (const t of raw) {
      if (t.modelGroups.length > 0) {
        for (const g of t.modelGroups) {
          const name = g.trim();
          if (!name) continue;
          const arr = groupMap.get(name) ?? [];
          arr.push(t);
          groupMap.set(name, arr);
        }
      } else {
        singles.push(t);
      }
    }
    const grouped: DemoGroupItem[] = [...groupMap.entries()].map(([groupName, members]) => {
      const sorted = [...members].sort((a, b) => Number(b.enabled) - Number(a.enabled));
      const rep = sorted[0]!;
      const withDemo = sorted.find((m) => m.demoVideo)?.demoVideo ?? null;
      return {
        id: `group:${groupName}`,
        isGroup: true,
        label: groupName,
        repKey: rep.key,
        count: members.length,
        enabled: members.some((m) => m.enabled),
        demoVideo: withDemo,
      };
    });
    const standalone: DemoGroupItem[] = singles.map((t) => ({
      id: `tool:${t.key}`,
      isGroup: false,
      label: t.name,
      repKey: t.key,
      count: 1,
      enabled: t.enabled,
      demoVideo: t.demoVideo ?? null,
    }));
    return [...grouped, ...standalone].sort(
      (a, b) => Number(b.enabled) - Number(a.enabled) || Number(b.isGroup) - Number(a.isGroup) || a.label.localeCompare(b.label, 'vi'),
    );
  })();

  const kw = search.trim().toLowerCase();
  const list = kw ? allItems.filter((item) => item.label.toLowerCase().includes(kw)) : allItems;
  const [selectedId, setSelectedId] = useState<string>('');
  const active = list.find((x) => x.id === selectedId) ?? allItems.find((x) => x.id === selectedId) ?? list[0];
  const [draft, setDraft] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const currentUrl = draft ?? active?.demoVideo ?? '';

  const save = useMutation({
    mutationFn: (url: string) =>
      api.put(`/admin/ai/tools/${encodeURIComponent(active!.repKey)}`, {
        demoVideo: url,
        applyDemoToGroup: active!.isGroup,
        ...(active!.isGroup ? { applyDemoGroup: active!.label } : {}),
      }),
    onSuccess: (_, url) => {
      toast.success(
        url
          ? active?.isGroup
            ? `Đã áp dụng video mẫu cho toàn bộ nhóm "${active.label}"`
            : `Đã lưu video mẫu cho "${active?.label}"`
          : `Đã gỡ video mẫu khỏi "${active?.label}"`,
      );
      setDraft(null);
      void qc.invalidateQueries({ queryKey: ['ai-tools'] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  return (
    <Section
      title="Video mẫu theo Nhóm Model"
      description="Chọn nhóm model rồi tải lên video (.mp4, .webm, .mov) hoặc ảnh (.gif, .webp, .png, .jpg) — bấm lưu 1 lần sẽ tự động áp dụng chung cho toàn bộ model trong nhóm đó."
    >
      {!active ? (
        <p className="text-xs text-muted-foreground">Đang tải danh sách nhóm model...</p>
      ) : (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-[220px_minmax(0,1fr)]">
            <Field label="Tìm nhanh nhóm">
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Gõ tên nhóm model..." />
            </Field>
            <Field
              label={`Chọn nhóm model cần gắn video mẫu (${list.length} nhóm)`}
              help={active.isGroup ? `Áp dụng chung một lượt cho cả ${active.count} model trong nhóm "${active.label}"` : `Công cụ độc lập (không thuộc nhóm)`}
            >
              <Select
                value={active.id}
                onValueChange={(id) => {
                  setSelectedId(id);
                  setDraft(null);
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {list.map((item) => (
                    <SelectItem key={item.id} value={item.id}>
                      {item.demoVideo ? '🎬 ' : ''}
                      {item.label}
                      {!item.enabled ? ' (đang tắt)' : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              className="min-w-60 flex-1"
              value={currentUrl}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Bấm Tải video lên hoặc dán link .mp4 / ảnh..."
            />
            <label className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-md border bg-background px-3 text-xs font-medium shadow-xs hover:bg-muted">
              {uploading ? <Loader2 className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />}
              {uploading ? 'Đang tải...' : 'Tải video / ảnh lên'}
              <input
                type="file"
                accept="video/mp4,video/webm,video/quicktime,image/gif,image/webp,image/png,image/jpeg"
                className="hidden"
                disabled={uploading}
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (!file) return;
                  setUploading(true);
                  try {
                    const fd = new FormData();
                    fd.append('file', file);
                    const r = await api.upload<{ url: string }>('/account/ai/uploads?demo=1', fd);
                    setDraft(r.url);
                    toast.success('Đã tải file lên — bấm Lưu video mẫu để áp dụng');
                  } catch (err) {
                    toast.error(errorMessage(err));
                  } finally {
                    setUploading(false);
                  }
                }}
              />
            </label>
            <Button type="button" size="sm" disabled={save.isPending} onClick={() => save.mutate(currentUrl)}>
              {save.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Film className="size-3.5" />} Lưu video mẫu
            </Button>
            {currentUrl && (
              <Button type="button" variant="outline" size="sm" disabled={save.isPending} onClick={() => save.mutate('')}>
                Gỡ
              </Button>
            )}
          </div>
          {currentUrl && (
            <div className="overflow-hidden rounded-xl border bg-black/95">
              {/\.(gif|webp|png|jpe?g)(\?|$)/i.test(currentUrl) ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={currentUrl} alt="" className="mx-auto max-h-52 w-full object-contain" />
              ) : (
                <video key={currentUrl} src={currentUrl} controls muted loop playsInline className="mx-auto max-h-52 w-full object-contain" />
              )}
            </div>
          )}
        </div>
      )}
    </Section>
  );
}
