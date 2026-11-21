/**
 * Giá trị mặc định cho từng nhóm cài đặt. Khi đọc, giá trị DB được merge lên trên.
 * `public: true` = được trả về cho storefront.
 */
/** Tự xoá tác vụ AI: không cho đặt dưới 7 ngày, tránh lỡ tay xoá gần hết lịch sử của khách (xem ai/ai-cleanup.service.ts) */
import { AHIEP_DEFAULT_COSTS } from '../ai/providers/ahiep.provider.js';
import { WEB_MENU_DEFAULT_ITEMS } from './web-menu.js';

export const AI_TASK_RETENTION_MIN_DAYS = 1;

export const SETTING_GROUPS: Record<string, { public: boolean; defaults: Record<string, unknown> }> = {
  general: {
    public: true,
    defaults: {
      siteName: { vi: 'NOV AI', en: 'NOV AI' },
      tagline: { vi: 'Nền tảng AI tạo video, ảnh, giọng nói', en: 'All-in-one AI video, image & voice studio' },
      // Địa chỉ website khách (frontend riêng). Để trống = chưa cấu hình: thanh toán báo lỗi, email bỏ link
      siteUrl: '',
      logo: null,
      logoDark: null,
      favicon: null,
      homepageId: null,
      timezone: 'Asia/Ho_Chi_Minh',
      dateFormat: 'dd/MM/yyyy',
      postsPerPage: 12,
      productsPerPage: 12,
      maintenanceMode: false,
      maintenanceMessage: { vi: 'Website đang bảo trì, vui lòng quay lại sau.', en: 'We are under maintenance.' },
    },
  },
  contact: {
    public: true,
    defaults: {
      companyName: '',
      email: '',
      phone: '',
      hotline: '',
      address: { vi: '', en: '' },
      mapEmbed: '',
      workingHours: { vi: '', en: '' },
      taxCode: '',
    },
  },
  social: {
    public: true,
    defaults: { facebook: '', youtube: '', tiktok: '', instagram: '', zalo: '', x: '', linkedin: '', messenger: '' },
  },
  seo: {
    public: true,
    defaults: {
      titleTemplate: '%title% | %siteName%',
      defaultTitle: {
        vi: 'Nền tảng Tạo Video AI, Ảnh 4K & Giọng Nói AI Đa Ngôn Ngữ',
        en: 'All-in-One AI Video, 4K Image & Voice Generation Studio',
      },
      defaultDescription: {
        vi: 'Sáng tạo Video AI điện ảnh, nâng cấp 4K, tạo ảnh Ultra HD và chuyển văn bản thành giọng nói 30 ngôn ngữ tự nhiên với Seedance, Kling, Veo, Grok giá tốt.',
        en: 'Create cinematic AI videos, upscale to 4K, generate Ultra HD images, and clone natural voices in 30 languages with Seedance, Kling, Veo & Grok at low cost.',
      },
      defaultKeywords: {
        vi: 'tạo video ai, ảnh thành video ai, tạo ảnh ai 4k, chuyển văn bản thành giọng nói, nhân bản giọng nói ai, nâng cấp video 4k, motion control ai, kling ai, veo 3, seedance 2.5, grok video',
        en: 'ai video generator, image to video ai, 4k ai image generator, text to speech ai, ai voice cloning, 4k video upscaler, motion control ai, kling ai, veo 3, seedance 2.5',
      },
      defaultOgImage: null,
      twitterHandle: '',
      robotsTxt: 'User-agent: *\nAllow: /\nAllow: /dashboard\nAllow: /tools/\nAllow: /community\nAllow: /pricing\nAllow: /service-pricing\nAllow: /api-docs\nDisallow: /account\nDisallow: /history\nDisallow: /transactions\nDisallow: /api-keys\nDisallow: /support\nDisallow: /affiliate\nDisallow: /checkout\nDisallow: /api/account/\nDisallow: /api/admin/',
      noindexSite: false,
      googleVerification: '',
      bingVerification: '',
      organizationType: 'Organization',
      organizationLogo: null,
      sitemapIncludeImages: true,
    },
  },
  // Bật/tắt cả mảng tính năng theo loại website (FEATURE_KEYS trong @cmsnt/shared/content)
  features: {
    public: true,
    defaults: { shop: true, blog: true, accounts: true, comments: false, reviews: true, wallet: true, wishlist: true, search: true },
  },
  appearance: {
    public: true,
    defaults: {
      theme: 'default',
      primaryColor: '#2563eb',
      secondaryColor: '#0f172a',
      accentColor: '#f59e0b',
      fontFamily: 'Be Vietnam Pro',
      borderRadius: 'md',
      headerStyle: 'default',
      stickyHeader: true,
      headerBlockKey: '',
      footerBlockKey: '',
      showTopbar: true,
      topbarText: { vi: 'Hệ thống tạo Video, Ảnh, Giọng nói AI tự động 24/7', en: '24/7 Automated AI Video, Image & Voice Platform' },
    },
  },
  /**
   * Tiền tệ hiển thị trên website khách: số dư, giá lưu theo tiền gốc (VND), khách chọn USD thì chỉ QUY ĐỔI khi hiển thị.
   * `usdRate` = 1 USD bằng bao nhiêu đồng (web đọc ở lib/i18n/config.ts → parseCurrencyConfig);
   * `currencies` = tiền tệ phụ admin bật (hiện chỉ USD), tắt `enabled` thì khách chỉ thấy VNĐ.
   */
  currency: {
    public: true,
    defaults: {
      currency: 'VND',
      decimals: 0,
      usdRate: 26000,
      currencies: [{ code: 'USD', name: 'US Dollar', rate: 26000, decimals: 2, enabled: true }],
    },
  },
  commerce: {
    public: true,
    defaults: {
      currency: 'VND',
      currencySymbol: '₫',
      currencyPosition: 'after',
      thousandSeparator: '.',
      decimalSeparator: ',',
      decimals: 0,
      enableCart: true,
      enableGuestCheckout: true,
      taxRate: 0,
      pricesIncludeTax: true,
      shippingFlatRate: 30000,
      freeShippingThreshold: 500000,
      orderCodePrefix: 'DH',
      paymentMethods: [
        { key: 'cod', enabled: true, label: { vi: 'Thanh toán khi nhận hàng (COD)', en: 'Cash on delivery' }, description: { vi: '', en: '' } },
        { key: 'bank_transfer', enabled: true, label: { vi: 'Chuyển khoản ngân hàng', en: 'Bank transfer' }, description: { vi: 'Vui lòng ghi mã đơn hàng trong nội dung chuyển khoản.', en: 'Please include your order code.' } },
      ],
      lowStockThreshold: 5,
      // thanh toán online
      paymentExpireMinutes: 30,
      autoCancelUnpaidMinutes: 0,
      autoConfirmPaidOrders: true,
      // cho khách thanh toán bằng số dư ví
      walletPaymentEnabled: true,
      // đánh giá sản phẩm
      enableReviews: true,
      reviewRequireLogin: false,
      reviewRequirePurchase: false,
      reviewAutoApprove: false,
      orderNotifyEmails: [],
      // cho khách tick "Yêu cầu xuất hoá đơn điện tử" ở checkout (nhập tên công ty, MST, địa chỉ, email nhận HĐ)
      invoiceRequestEnabled: false,
      // bắt buộc nhập MST khi chọn loại công ty
      invoiceRequireTaxCode: true,
      // nhắc giỏ hàng bỏ dở qua email (modules/carts, cron 15 phút; số giờ tính từ lần hoạt động cuối)
      abandonedCart: { enabled: false, firstDelayHours: 1, secondDelayHours: 24, maxAgeDays: 7 },
    },
  },
  // Vận chuyển qua API hãng (nhóm riêng tư — chứa token hãng)
  shipping: {
    public: false,
    defaults: {
      // môi trường: sandbox | production
      environment: 'sandbox',
      // cấu hình từng hãng: { ghn: { enabled, token, shopId, ... }, ghtk: {...} }
      carriers: {},
      // kho / điểm lấy hàng mặc định
      pickup: { name: '', phone: '', line1: '', provinceCode: '', provinceName: '', districtCode: '', districtName: '', wardCode: '', wardName: '' },
      // kiện hàng mặc định khi sản phẩm không khai (gram / cm)
      defaultWeight: 500,
      defaultLength: 20,
      defaultWidth: 15,
      defaultHeight: 10,
      // thu hộ COD khi đơn chưa thanh toán (phương thức cod)
      codForUnpaid: true,
      // khai giá / bảo hiểm theo giá trị đơn
      insureByOrderValue: true,
      // cho xem hàng: allow | deny | try
      allowInspection: 'allow',
      // tự tạo vận đơn: manual | confirmed (khi đơn xác nhận) | paid (khi thanh toán xong)
      autoCreateShipment: 'manual',
      // tự cập nhật trạng thái đơn theo vận đơn (DELIVERING -> SHIPPING, DELIVERED -> COMPLETED)
      syncOrderStatus: true,
      // cache báo giá (phút)
      rateCacheMinutes: 10,
      // làm tròn phí hiện cho khách (VND): 0 = không, 1000 = làm tròn nghìn
      feeRounding: 0,
      // chuỗi bí mật thêm vào URL webhook /public/shipping/webhook/:carrier?key=...
      webhookSecret: '',
    },
  },
  // Hoá đơn điện tử (nhóm riêng tư — chứa tài khoản nhà cung cấp, không gửi ra storefront)
  einvoice: {
    public: false,
    defaults: {
      // key nhà cung cấp đang dùng: none | viettel | vnpt | misa | bkav | easyinvoice | fpt | mobifone | custom | manual
      provider: 'none',
      // môi trường: sandbox | production
      environment: 'sandbox',
      // thời điểm tự động xuất: manual (không tự) | paid (khi thanh toán xong) | completed (khi đơn hoàn thành)
      autoIssue: 'manual',
      // chỉ tự xuất khi khách có yêu cầu xuất hoá đơn lúc đặt hàng
      autoIssueOnlyWhenRequested: true,
      // trễ bao nhiêu phút sau sự kiện mới phát hành (để kịp huỷ / sửa đơn)
      autoIssueDelayMinutes: 0,
      // tự huỷ hoá đơn khi đơn bị hoàn tiền toàn bộ / huỷ
      autoCancelOnRefund: false,
      // gửi email hoá đơn (link tra cứu + PDF) cho khách sau khi phát hành
      sendEmailToBuyer: true,
      // thuế suất GTGT mặc định (%): 0, 5, 8, 10; -1 = KCT (không chịu thuế); -2 = KKKNT (không kê khai nộp thuế)
      defaultVatRate: 10,
      // giá sản phẩm đã gồm VAT (tách ngược khi lập hoá đơn)
      pricesIncludeVat: true,
      // mẫu số & ký hiệu hoá đơn (TT78: mẫu "1", ký hiệu "C25TAA")
      templateCode: '1',
      serial: '',
      // phí vận chuyển thành 1 dòng hàng trên hoá đơn
      shippingAsLine: true,
      // tên dòng phí vận chuyển
      shippingLineName: 'Phí vận chuyển',
      // đơn vị tính mặc định cho dòng hàng
      defaultUnit: 'Cái',
      // cách thể hiện giảm giá: perLine (phân bổ vào từng dòng) | separate (dòng chiết khấu riêng)
      discountMode: 'perLine',
      // ánh xạ phương thức thanh toán đơn hàng -> hình thức thanh toán trên hoá đơn
      paymentMethodMap: { cod: 'TM', bank_transfer: 'CK', wallet: 'CK', default: 'TM/CK' },
      // thông tin người bán in trên hoá đơn
      seller: { name: '', taxCode: '', address: '', phone: '', email: '', bankAccount: '', bankName: '' },
      // cấu hình từng nhà cung cấp (field theo /admin/einvoices/providers)
      providers: {},
    },
  },
  scripts: {
    public: true,
    defaults: { headCode: '', bodyStartCode: '', bodyEndCode: '' },
  },
  /** Mã theo dõi GA4 / GTM / Pixel — public để frontend riêng tự chèn script */
  tracking: {
    public: true,
    defaults: { enabled: true, ga4Id: '', gtmId: '', fbPixelId: '', tiktokPixelId: '' },
  },
  /**
   * Nút liên hệ nổi ở góc màn hình website khách: bật/tắt + icon riêng từng kênh (Telegram, Zalo, Messenger...).
   * Cấu trúc + kênh có sẵn: normalizeContactButtons trong @cmsnt/shared/contact-buttons (controller chuẩn hoá khi lưu).
   */
  contactButtons: {
    public: true,
    defaults: { enabled: true, position: 'right', defaultOpen: false, items: [] },
  },
  /**
   * Menu bên trái website khách — admin sửa ở trang Menu website (/web-menu). Cấu trúc + chuẩn hoá: web-menu.ts.
   * Public để website đọc qua /public/bootstrap.
   */
  web_menu: {
    public: true,
    defaults: { items: WEB_MENU_DEFAULT_ITEMS },
  },
  /**
   * Thông báo nổi (popup) hiện khi khách vào website (web: components/site/popup-notice.tsx).
   * content: mỗi dòng 1 đoạn, **chữ** = in đậm; audience: all | member | guest;
   * frequency: once (tới khi đổi nội dung) | daily | session | always. Controller chuẩn hoá khi lưu.
   */
  popup: {
    public: true,
    defaults: { enabled: false, title: 'Thông báo', content: '', image: '', buttonLabel: '', buttonUrl: '', audience: 'all', frequency: 'once', delay: 1 },
  },
  /**
   * Chế độ demo (common/guards/demo-mode.guard.ts): bật thì API từ chối mọi thao tác thêm/sửa/xoá,
   * trừ tài khoản vai trò Nhà phát triển. Public để trang quản trị/frontend hiện thanh thông báo.
   */
  demo: {
    public: true,
    defaults: { enabled: false, message: 'Bạn đang xem bản demo — mọi thao tác thêm, sửa, xoá đã bị khoá.' },
  },
  /** Email thông báo đơn hàng cho cửa hàng + khách (modules/email-notifications) */
  orderNotification: {
    public: false,
    defaults: {
      enabled: true,
      /** phân tách dấu phẩy; trống = dùng commerce.orderNotifyEmails */
      adminEmails: '',
      sendCustomerEmail: true,
      notifyStatusChange: true,
    },
  },

  // Cổng thanh toán online (modules/payment-gateways) — trường bí mật khai báo trong SECRET_FIELDS của settings.controller
  payos: {
    public: false,
    defaults: { enabled: false, clientId: '', apiKey: '', checksumKey: '', descriptionLength: 25, showQr: true },
  },
  sepay: {
    public: false,
    defaults: { enabled: false, bank: '', accountNumber: '', accountName: '', authMode: 'apikey', apiKey: '', hmacSecret: '', qrTemplate: 'compact' },
  },
  pay2s: {
    public: false,
    defaults: { enabled: false, partnerCode: '', partnerName: '', accessKey: '', secretKey: '', bankAccounts: '', endpoint: 'https://payment.pay2s.vn', webhookToken: '' },
  },
  /** Ngân hàng tự động qua Web2M (api.web2m.com) — cổng duy nhất đang dùng; token = Access Token (Bearer) của webhook Web2M */
  web2m: {
    public: false,
    defaults: { enabled: false, bank: '', accountNumber: '', accountName: '', token: '', qrTemplate: 'compact2' },
  },
  /**
   * Thanh toán USDT qua USDT Gateway (dự án gateway_blockchain, API tương thích NTPAY) — payment-gateways/usdt.provider.ts.
   * endpoint = địa chỉ gateway, merchantId / apiKey cấp khi tạo Merchant (gateway crypto), rate = số VND cho 1 USDT.
   */
  usdt: {
    public: false,
    defaults: { enabled: false, endpoint: '', merchantId: '', apiKey: '', rate: 26000, minUsdt: 1 },
  },
  /**
   * Khách tự nạp tiền vào ví qua cổng thanh toán online (PayOS / SePay / Pay2S) — modules/payments.
   * topupProviders rỗng = cho dùng mọi cổng đang bật; topupMin / topupMax tính bằng VND.
   */
  wallet: {
    public: false,
    defaults: { topupEnabled: false, topupProviders: [], topupMin: 10000, topupMax: 50000000 },
  },
  /**
   * Số dư AI (modules/credits, tính bằng VND = số dư ví): tiền tặng khi đăng ký, số luồng chạy cùng lúc,
   * quyền lợi chung + ghi chú hiện dưới bảng giá gói nạp tiền.
   */
  credits: {
    public: false,
    defaults: {
      signupBonus: 1500,
      defaultConcurrency: 2,
      packFeatures: [
        'Số dư không có thời hạn',
        'Tạo video AI tốc độ cao',
        'Không gắn watermark',
        'Truy cập các mô hình AI mới nhất',
        'Không cần máy tính cấu hình cao',
        'Hỗ trợ khách hàng 24/7',
        'Chất lượng video HD / Full HD / 4K',
        'Tạo video từ ảnh hoặc văn bản',
        'Tiền được cộng vào số dư ngay sau khi thanh toán',
        'Cập nhật tính năng và mô hình AI thường xuyên',
      ],
      packNote: '',
      /**
       * Nạp tiền theo số tiền tự do (credits.settings.ts › normalizeTopup / quoteTopup): `rate` = số đồng vào số dư cho mỗi 1đ trả,
       * hạn mức mỗi lần, mức gợi ý, mốc khuyến mãi theo số tiền (`tiers`: nạp từ `min`đ được tặng thêm `bonus`%)
       * và chương trình khuyến mãi có thời hạn (`promo`, cộng dồn với mốc).
       */
      topup: {
        rate: 1,
        min: 10000,
        max: 100000000,
        presets: [50000, 100000, 200000, 500000, 1000000, 2000000, 5000000, 10000000],
        tiers: [
          { min: 500000, bonus: 3 },
          { min: 1000000, bonus: 5 },
          { min: 2000000, bonus: 8 },
          { min: 5000000, bonus: 10 },
          { min: 10000000, bonus: 15 },
        ],
        promo: { enabled: false, bonus: 10, label: 'Khuyến mãi', startsAt: '', endsAt: '' },
      },
    },
  },
  /** Tiếp thị liên kết (modules/affiliate): % hoa hồng trên tiền nạp của người được giới thiệu, rút tối thiểu */
  affiliate: {
    public: false,
    defaults: { enabled: true, commission: 10, minPayout: 50_000, walletPayout: true, bankPayout: true, blockSameIp: true },
  },
  /**
   * AI Studio (modules/ai) — cấu hình chung: chu kỳ hỏi trạng thái tác vụ, thời gian tối đa một tác vụ,
   * dung lượng file khách tải lên làm đầu vào, tự xoá tác vụ cũ (`taskRetentionDays`, 0 = giữ vĩnh viễn; xem ai-cleanup.service.ts).
   * Khoá API của từng nhà cung cấp nằm ở nhóm `ai_<nhà cung cấp>`.
   */
  ai: {
    public: false,
    defaults: { pollSeconds: 10, timeoutMinutes: 45, maxUploadMb: 50, maxMediaUploadMb: 1024, mirrorOutputs: true, mirrorMaxMb: 300, taskRetentionDays: 1, taskRetentionKeepPublic: true },
  },
  /**
   * Nhóm công cụ AI (menu website khách, bộ lọc admin) — admin thêm / sửa / sắp xếp ở AI Studio › Công cụ AI › tab Nhóm.
   * Thứ tự trong `items` = thứ tự hiển thị; `key` lưu vào ai_tools.category, `icon` là tên icon lucide.
   */
  ai_categories: {
    public: false,
    defaults: {
      items: [
        { key: 'video', label: 'Video', icon: 'video' },
        { key: 'image', label: 'Hình ảnh', icon: 'image' },
        { key: 'voice', label: 'Giọng nói', icon: 'mic' },
        { key: 'audio', label: 'Âm nhạc', icon: 'music' },
        { key: 'text', label: 'Văn bản', icon: 'scroll-text' },
        { key: 'tools', label: 'Công cụ', icon: 'wrench' },
      ],
    },
  },
  /** Nhà cung cấp AI — mỗi nhóm { enabled, autoName, baseUrl, apiKey } (apiKey là trường bí mật, xem SECRET_FIELDS) */
  ai_tmc: { public: false, defaults: { enabled: false, autoName: true, baseUrl: 'https://tmcvideoai.net/api/v1', apiKey: '' } },
  ai_aideepcut: { public: false, defaults: { enabled: false, autoName: true, baseUrl: 'https://aideepcut.com/api/v1', apiKey: '', sessionCookie: '' } },
  ai_kapend: { public: false, defaults: { enabled: false, autoName: true, baseUrl: 'https://kapend.com', apiKey: '' } },
  ai_imgstudio: { public: false, defaults: { enabled: false, autoName: true, baseUrl: 'https://imgstudio.site', apiKey: '' } },
  // VidGrab (dowloadvideo.io.vn): API thật chạy ở máy chủ riêng
  ai_vidgrab: { public: false, defaults: { enabled: false, autoName: true, baseUrl: 'https://dvid-api.vibe1.tinhgon.xyz', apiKey: '' } },
  ai_yupvox: { public: false, defaults: { enabled: false, autoName: true, baseUrl: 'https://api.yupvox.com', apiKey: '' } },
  /**
   * AHiep API (OpenAI-compatible). Giá vốn admin nhập để tính giá bán "theo chi phí NCC" (xem ahiep.provider.ts):
   * tokenCosts = đ / 1 triệu token theo model chat, imageCosts = đ / ảnh theo model ảnh, videoCostPerVideo = đ / mỗi video.
   */
  ai_ahiep: { public: false, defaults: { enabled: false, autoName: true, baseUrl: 'https://api.ahiep.com/v1', apiKey: '', ...AHIEP_DEFAULT_COSTS } },
  // Vimo Video (Motion Studio): Motion control V2, giá theo xu Vimo đọc ở GET /workflows
  ai_vimo: { public: false, defaults: { enabled: false, autoName: true, baseUrl: 'https://vimovideo.com/api/v1', apiKey: '' } },
  ai_runup: { public: false, defaults: { enabled: false, autoName: true, baseUrl: 'https://runup.studio/api/v1', apiKey: '' } },
  ai_tavtavvideo: { public: false, defaults: { enabled: false, autoName: true, baseUrl: 'https://nov.ai.vn/api/tavtavvideo-worker', apiKey: '' } },
  ai_fable: { public: false, defaults: { enabled: false, autoName: true, baseUrl: 'https://fablemedical.shop/v1', apiKey: '' } },
  ai_prismforge: { public: false, defaults: { enabled: false, autoName: true, baseUrl: 'https://prismforge.cloud/v1', apiKey: '' } },
  ai_up4k: { public: false, defaults: { enabled: false, autoName: true, baseUrl: 'https://up4k.io/api/v1', apiKey: '', rate: 2620 } },
  ai_ivoi: { public: false, defaults: { enabled: false, autoName: true, baseUrl: 'https://ivoi.io/api', apiKey: '', rate: 500 } },
  ai_tramsangtao: { public: false, defaults: { enabled: false, autoName: true, baseUrl: 'https://api.tramsangtao.com/v1', apiKey: '', rate: 49.5 } },
  ai_gommo: { public: false, defaults: { enabled: false, autoName: true, baseUrl: 'https://v2.api.gommo.net', apiKey: '', rate: 1.05, domain: '79ai.net' } },
  ai_botsd: { public: false, defaults: { enabled: false, autoName: true, baseUrl: 'https://botsd.pro', apiKey: '', rate: 454.55 } },
  ai_maivideo: { public: false, defaults: { enabled: false, autoName: true, baseUrl: 'https://maivideo.top', apiKey: '', sessionCookie: '', rate: 1000, markup: 35, autoPrice: true } },
  ai_aishop24: { public: false, defaults: { enabled: false, autoName: true, baseUrl: 'https://aishop24.io.vn', apiKey: '', rate: 95, markup: 28, autoPrice: true } },
  ai_plenxai: { public: false, defaults: { enabled: false, autoName: true, baseUrl: 'https://plenxai.com', apiKey: '', sessionCookie: '', rate: 84, markup: 28, autoPrice: true } },
  ai_seedancebot: { public: false, defaults: { enabled: false, autoName: true, baseUrl: 'https://api.seedancecreationbot.online', apiKey: '', rate: 1, markup: 28, autoPrice: true } },
  /**
   * Bot Telegram (modules/telegram), botToken là trường bí mật (SECRET_FIELDS). Hai bot tách riêng:
   * - telegram_user: bot báo khách — khách liên kết ở trang Tài khoản; `events` = loại thông báo admin cho phép (khách tự tắt bớt).
   * - telegram_admin: bot báo quản trị — gửi vào `chatIds` (chat riêng / nhóm, phân tách dấu phẩy); `thresholds` = ngưỡng số dư
   *   từng nguồn API { tmc: 500, ... } (theo đơn vị của nguồn), kiểm tra mỗi `balanceCheckMinutes`, nhắc lại sau `balanceRemindHours` nếu chưa nạp.
   * Hai bot dùng chung một token cũng được (một vòng nhận lệnh xử lý cả hai).
   */
  telegram_user: {
    public: false,
    defaults: { enabled: false, botToken: '', events: { taskSucceeded: true, taskFailed: true, topup: true, plan: true, affiliate: true } },
  },
  telegram_admin: {
    public: false,
    defaults: {
      enabled: false,
      botToken: '',
      chatIds: '',
      events: { newUser: true, topup: true, plan: true, payout: true, needsRefund: true, taskFailed: false, providerError: true, security: true, lowBalance: true, newModel: true },
      thresholds: {},
      balanceCheckMinutes: 30,
      balanceRemindHours: 6,
      catalogCheckMinutes: 60,
    },
  },
  /** Nạp thẻ cào vào ví (modules/card-topup) — chọn MỘT nhà cung cấp đổi thẻ; partnerKey là trường bí mật */
  card_topup: {
    public: false,
    defaults: {
      enabled: false,
      provider: 'card24h',
      domain: '',
      method: 'POST',
      partnerId: '',
      partnerKey: '',
      creditMode: 'discount',
      discount: 20,
      wrongValuePenalty: 50,
      telcos: [
        { code: 'VIETTEL', name: 'Viettel', enabled: true, discount: null, serialLength: '11,14', pinLength: '13,15' },
        { code: 'VINAPHONE', name: 'Vinaphone', enabled: true, discount: null, serialLength: '14', pinLength: '14' },
        { code: 'MOBIFONE', name: 'Mobifone', enabled: true, discount: null, serialLength: '15', pinLength: '12' },
        { code: 'VNMOBI', name: 'Vietnamobile', enabled: false, discount: null, serialLength: '16', pinLength: '12' },
        { code: 'ZING', name: 'Zing', enabled: false, discount: null, serialLength: '12', pinLength: '9' },
        { code: 'GARENA', name: 'Garena', enabled: false, discount: null, serialLength: '9', pinLength: '16' },
        { code: 'VCOIN', name: 'Vcoin', enabled: false, discount: null, serialLength: '12', pinLength: '12' },
      ],
      amounts: [10000, 20000, 30000, 50000, 100000, 200000, 300000, 500000, 1000000],
      maxPending: 5,
      dailyFailLimit: 5,
      notice: '',
    },
  },
  mail: {
    public: false,
    defaults: {
      host: '',
      port: 587,
      secure: false,
      user: '',
      pass: '',
      fromName: 'NOV AI',
      fromEmail: '',
      // hàng chờ gửi email (modules/mail/mail-queue.service.ts): tối đa N email/phút (0 = không giới hạn),
      // số lần thử mỗi email, tạm dừng gửi
      rateLimitPerMinute: 60,
      maxAttempts: 5,
      queuePaused: false,
    },
  },
  /** Lịch sao lưu tự động (Công cụ › Sao lưu) */
  backup: {
    public: false,
    defaults: {
      /** none | daily | weekly (weekly = Chủ nhật) */
      schedule: 'none',
      /** giờ chạy theo múi giờ máy chủ (0-23) */
      hour: 3,
      /** số bản sao lưu giữ lại, bản cũ hơn tự xoá */
      keep: 7,
      includeUploads: false,
    },
  },
  account: {
    public: true,
    defaults: {
      allowRegistration: true,
      requireEmailVerification: false,
      /** Đăng nhập bằng Google cho khách (xác minh ID token phía server, không cần client secret) */
      googleLoginEnabled: false,
      /** OAuth Client ID (loại Web) lấy từ Google Cloud Console — công khai được, không phải bí mật */
      googleClientId: '',
    },
  },
  comments: {
    public: true,
    defaults: {
      enabled: true,
      requireLogin: false,
      autoApprove: false,
      allowReplies: true,
      /** độ sâu tối đa của cây bình luận (1 = không lồng, 2 = gốc + 1 cấp trả lời) */
      maxDepth: 2,
      /** email nhận thông báo khi có bình luận mới (để trống = không gửi) */
      notifyEmail: '',
      /** tự đóng bình luận sau N ngày kể từ khi đăng bài (0 = không đóng) */
      closeAfterDays: 0,
    },
  },
  /** Thống kê truy cập tự lưu (Báo cáo › Truy cập) — public để storefront biết có gửi lượt xem hay không */
  analytics: {
    public: true,
    defaults: {
      enabled: true,
      /** không ghi lượt xem của trình duyệt đang đăng nhập trang quản trị (cookie cmsnt_admin=1) */
      excludeAdmins: true,
      /** tôn trọng Do Not Track / Global Privacy Control của trình duyệt */
      respectDnt: false,
      /** mỗi dòng một tiền tố đường dẫn không ghi nhận, vd /tai-khoan */
      excludePaths: '',
      /** tự xoá lượt xem cũ hơn N ngày (0 = giữ vĩnh viễn) */
      retentionDays: 0,
    },
  },
  /** Nhật ký lỗi (Hệ thống › Nhật ký lỗi) — file log theo ngày ở LOG_DIR, xem modules/logs */
  logging: {
    public: false,
    defaults: {
      /** mức ghi tối thiểu: 'error' | 'warn' | 'info' | 'debug' */
      level: 'warn',
      /** tự xoá file log cũ hơn N ngày (0 = giữ vĩnh viễn) */
      retentionDays: 14,
      /** dung lượng tối đa file log mỗi ngày (MB); vượt thì chỉ ghi lỗi fatal */
      maxFileMb: 50,
      /** ghi cả lỗi 4xx (yêu cầu sai, không tìm thấy, chưa đăng nhập...) ở mức warn */
      log4xx: false,
      /** nhận lỗi JavaScript từ trình duyệt (website + trang quản trị) và lỗi máy chủ storefront */
      captureClient: true,
    },
  },
  // Kho mã số / sản phẩm ảo (modules/digital-codes)
  digital: {
    public: false,
    defaults: {
      /** gửi kèm nội dung mã trong email giao hàng (tắt = email chỉ có link xem mã trên website) */
      emailCodes: true,
      /** đơn chỉ gồm sản phẩm ảo / số đã giao đủ mã (và file) -> tự chuyển "Hoàn thành" */
      autoCompleteOrders: true,
      /** nhập thêm mã -> tự giao bù cho các đơn đã thanh toán đang thiếu mã */
      autoFulfillBackorders: true,
      /** báo admin khi số mã còn lại của sản phẩm / biến thể <= ngưỡng (0 = chỉ báo khi hết hẳn) */
      lowStockAlert: 5,
      /** cho khách báo lỗi mã trong thời gian bảo hành của sản phẩm */
      allowReports: true,
      /** khách vãng lai xem mã bằng mã đơn + SĐT (tắt = chỉ xem qua email / tài khoản) */
      guestAccess: true,
    },
  },
  security: {
    public: false,
    defaults: {
      /** 'none' | 'turnstile' | 'recaptcha-v2' | 'recaptcha-v3' | 'hcaptcha' */
      captchaProvider: 'none',
      captchaSiteKey: '',
      /** secret — luôn được mask khi trả về admin */
      captchaSecretKey: '',
      /** form nào bật captcha: forms (form tự viết của từng dự án), register, review, comment */
      captchaOn: ['forms', 'register', 'review', 'comment'],
      /** reCAPTCHA v3: điểm tối thiểu để chấp nhận (0–1) */
      recaptchaMinScore: 0.5,
      /** khoá tài khoản sau N lần sai mật khẩu */
      maxFailedLogins: 5,
      /** thời gian khoá (phút) */
      lockoutMinutes: 15,
      /** bắt buộc tài khoản có quyền admin.access phải bật xác thực 2 bước */
      require2faForAdmins: false,

      // ---- chống dò mật khẩu theo IP (credential stuffing): đếm lượt sai của 1 IP trên mọi tài khoản
      /** bật tự chặn IP khi sai quá nhiều */
      ipProtection: true,
      /** số lượt sai tối đa của 1 IP trong cửa sổ thời gian */
      ipMaxFailures: 20,
      /** cửa sổ đếm (phút) */
      ipWindowMinutes: 15,
      /** thời gian tự chặn IP (phút) */
      ipBlockMinutes: 60,
      /** chỉ IP trong danh sách "cho phép" mới vào được trang quản trị — chỉ bật qua Trung tâm bảo mật (kiểm tra IP hiện tại) */
      adminIpAllowlist: false,

      // ---- chính sách mật khẩu (áp dụng khi đặt mật khẩu mới: đăng ký, đổi, đặt lại, admin tạo/sửa thành viên)
      passwordMinLength: 8,
      passwordRequireUppercase: false,
      passwordRequireLowercase: false,
      passwordRequireNumber: false,
      passwordRequireSymbol: false,
      /** chặn mật khẩu phổ biến (123456, password, matkhau...) */
      passwordBlockCommon: true,
      /** không cho mật khẩu chứa email / tên */
      passwordBlockPersonalInfo: true,

      // ---- phiên đăng nhập trang quản trị (tài khoản có quyền admin.access)
      /** tự đăng xuất sau N phút không hoạt động (0 = không giới hạn) */
      adminIdleTimeoutMinutes: 0,
      /** phiên tối đa N giờ kể từ lúc đăng nhập, sau đó phải đăng nhập lại (0 = theo hạn refresh token) */
      adminSessionMaxHours: 0,
      /** cho phép đăng nhập song song nhiều thiết bị; false = đăng nhập mới sẽ đăng xuất các thiết bị khác */
      adminAllowConcurrentSessions: true,

      // ---- cảnh báo
      /** email báo khi đăng nhập từ thiết bị mới: off | admins | all */
      newDeviceAlert: 'admins',
      /** thông báo (chuông) cho quản trị viên khi tài khoản bị khoá hoặc IP bị tự chặn */
      notifyOnLockout: true,
      /** giữ nhật ký đăng nhập bao nhiêu ngày */
      loginLogRetentionDays: 90,
    },
  },
};
