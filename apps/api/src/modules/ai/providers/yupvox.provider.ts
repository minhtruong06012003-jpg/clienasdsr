import { BadRequestException } from '@nestjs/common';
import { AiProviderError, type AiCallContext, type AiFieldOption, type AiInput, type AiOutputFile, type AiProvider, type AiProviderResult, type AiToolDef } from '../ai.types.js';
import { guessType, pickMessage, providerFetch, str } from './http.js';

/**
 * YupVox — https://yupvox.com/api-keys (base https://api.yupvox.com, header Authorization: Bearer sk-yupvox-...).
 * Envelope { success, data, error: { code, message } }. Đã chạy thử với khoá thật (30/10/2026):
 * - TTS: POST /v1/tts { voiceId, text, speed } -> data.jobId; hỏi GET /v1/tts/:jobId tới khi status = completed (audioUrl). 1 credit / ký tự.
 * - Phụ đề -> audio: POST /v1/subtitle-to-audio { srtText, voiceId } -> jobId, cũng hỏi qua GET /v1/tts/:jobId
 *   (GET /v1/subtitle-to-audio/:id trả NOT_FOUND). Tính 1 credit / ký tự của cả nội dung SRT.
 * - STT: POST /v1/stt { audioUrl, language } — ĐỒNG BỘ, trả luôn { textResult, segments[{start_time,end_time,text}] (ms), duration (ms), cost };
 *   khoảng 5 credit / giây âm thanh.
 * - Đổi giọng: POST /v1/voice-changer chỉ trả transcribedText, không tạo file audio (audioUrl null trong lịch sử)
 *   -> tự làm 2 bước: STT bóc chữ rồi TTS đọc lại bằng giọng đích.
 * - Dịch phụ đề: POST /v1/translate-subtitles — ĐỒNG BỘ, trả luôn srtText / bilingualSrtText (1 credit / ký tự Latin, 2,5 với CJK).
 * - Nhân bản giọng: POST /v1/voice-cloning/create { voiceName, audioUrl, engine: omega|alpha, language, gender, privacy } -> data.voiceCode.
 * - Lồng tiếng: POST /v1/dubbing { audioUrl, targetLang, targetVoiceId, speed } -> audioUrl (theo yupvox.com/api; 30/10/2026 từng trả NOT_FOUND).
 *   Hai công cụ này viết theo tài liệu, chưa chạy thử với khoá thật.
 * Thêm 31/10/2026 theo tài liệu API (yupvox.com/api-keys), chưa chạy thử với khoá thật:
 * - TTS hội thoại nhiều giọng: POST /v1/tts { blocks: [{ voiceId, text, pauseBefore, pauseAfter, speed }] } -> jobId,
 *   hỏi như TTS thường; xong có audioUrl + outputSrtUrl. 1 credit / ký tự.
 * - Lồng tiếng & dịch video: POST /v1/video-dubbing { mediaUrl, targetLang, sourceLang, toolType, voiceMode, targetVoiceId } -> jobId
 *   (mỗi ngôn ngữ một job), hỏi GET /v1/video-dubbing/:jobId tới khi completed (videoUrl, audioUrl, srtUrl).
 *   Video 100 credit / giây, audio 50 credit / giây (máy chủ YupVox đo thời lượng, làm tròn lên giây).
 *   Gửi thêm các trường công cụ web yupvox.com/translate-video dùng: voiceSource (auto | original | manual),
 *   subMaskMode (kiểu che phụ đề gốc), enableDelogo (AI xoá mờ sub gốc), targetRes (hd | sd), targetAspect.
 * - Tin tức thành video: POST /v1/article-to-video { url | text, targetDuration, aspectRatio, language, stylePreset, voiceId } -> jobId,
 *   hỏi GET /v1/article-to-video/:jobId (scripting -> rendering -> completed + videoUrl). Giá cố định theo thời lượng chọn
 *   (30s 10.000 · 60s 20.000 · 90s 25.000 · 120s 30.000 credit). Logo / intro / màn kết lấy theo cài đặt đã lưu trong
 *   công cụ Tin tức thành video của tài khoản YupVox chủ khoá API.
 */

const opts = (list: [string, string][]): AiFieldOption[] => list.map(([value, label]) => ({ value, label }));

/**
 * 50 giọng tiếng Việt chính thức dùng nhiều nhất (GET /v1/voices?language=vi — endpoint công khai, 31/10/2026; bỏ giọng clone của người dùng):
 * [mã giọng, tên, giới tính, mô tả, file nghe thử (previewVoiceUrl)]. Ô chọn giọng hiện hộp chọn có nút ▶ nghe thử (picker 'voice'),
 * file nghe thử được API tải hộ qua /public/ai/voice-preview nên khách không thấy địa chỉ nhà cung cấp.
 */
const VOICE_LIST: [string, string, 'male' | 'female', string, string][] = [
  ['DDC251', 'Huyền', 'female', 'Hanoi, Standard', 'https://img01.reimgx.com/previews/preview_1784411758892_vz4omd.mp3'],
  ['VV0002', 'Đọc Truyện Audio', 'female', 'Giọng nữ miền Bắc: Tối ưu cho đọc truyện dài tập, sách nói, video re…', 'https://cdn.yupvox.com/previews/preview_1785635529706_5qdv45.mp3'],
  ['VV0012', 'Quang Anh', 'male', 'Giọng nam miền Bắc: Chuẩn thời sự, uy nghiêm và đĩnh đạc. Lý tưởng c…', 'https://cdn.yupvox.com/previews/preview_1785635641344_x33ed.mp3'],
  ['ECF913', 'Bích Ngọc', 'female', 'Young, energetic', 'https://img01.reimgx.com/previews/preview_1784425236651_9bg2rj.mp3'],
  ['VV0041', 'Adam Trà Đá (Các Con Vợ)', 'male', 'Giọng Adam lồng tiếng Video đang hot trend Tiktok hiện nay. Nổi tiến…', 'https://cdn.yupvox.com/voices/1-CL0227-1787969573689.mp3'],
  ['DFE237', 'Hoài My', 'female', 'Hanoi, Standard', 'https://img01.reimgx.com/previews/preview_1784411282564_n4ffk.mp3'],
  ['VV0022', 'Bảo Anh', 'female', 'Giọng nữ miền Bắc: Dịu dàng, êm ái và chữa lành sâu sắc. Dành cho đọ…', 'https://cdn.yupvox.com/previews/preview_1785635771574_fk1pd7.mp3'],
  ['EFC483', 'Thu Minh', 'female', 'Cute, sweet', 'https://img01.reimgx.com/previews/preview_1784425252416_bbdvfk.mp3'],
  ['VV0021', 'Chi Mai', 'female', 'Giọng nữ miền Bắc: Nhỏ nhẹ, thầm thì như bé gái. Chuyên cho lồng tiế…', 'https://cdn.yupvox.com/previews/preview_1785635760089_p3djqh.mp3'],
  ['VV0009', 'Giọng Adam (Giọng đều)', 'male', 'Giọng nam miền Bắc: Hài hước, dí dỏm và vô tri bắt trend. Chuyên dùn…', 'https://cdn.yupvox.com/previews/preview_1785635605476_h7cmtd.mp3'],
  ['VV0024', 'Trường An (Phật Pháp)', 'male', 'Giọng nam miền Nam: Trung trầm, truyền cảm và tĩnh lặng. Dành riêng…', 'https://cdn.yupvox.com/previews/preview_1785635794511_hvryud.mp3'],
  ['DFE601', 'Onyx', 'male', 'Older, mature, and experienced', 'https://img01.reimgx.com/previews/preview_1784410059910_6tavnu.mp3'],
  ['VV0005', 'Chuyên Review', 'female', 'Giọng nữ miền Nam: Nhịp độ nhanh, dứt khoát và sôi nổi. Chuyên cho v…', 'https://cdn.yupvox.com/previews/preview_1785635551304_yyi4gg.mp3'],
  ['BEB861', 'Nam Minh', 'male', 'Saigon, Standard', 'https://img01.reimgx.com/previews/preview_1784411284288_cds6vk.mp3'],
  ['ADC689', 'Khôi', 'male', 'Hanoi, Storytelling', 'https://img01.reimgx.com/previews/preview_1784411777832_cakuu.mp3'],
  ['VV0006', 'Adam (Giọng miền Nam)', 'male', 'Giọng nam miền Nam: Tự nhiên, phóng khoáng và hài hước. Phù hợp cho…', 'https://cdn.yupvox.com/previews/preview_1785635562983_itlldl.mp3'],
  ['AEE454', 'Nhật Huy', 'male', 'Confident, male', 'https://img01.reimgx.com/previews/preview_1784425229416_c4lyp8.mp3'],
  ['F00277', 'Giọng Nam Trầm Ấm', 'male', 'Giọng nam trầm ấm, rõ ràng và truyền cảm, rất phù hợp cho việc kể ch…', 'https://cdn.yupvox.com/voices/F00277.mp3'],
  ['VV0045', 'Huy Vũ', 'male', 'Giọng nam miền Bắc: Gần gũi, thân mật và nhẹ nhàng. Lý tưởng cho pod…', 'https://cdn.yupvox.com/previews/preview_1785636032563_id9m4h.mp3'],
  ['VI0001', 'Minh Đức', 'male', 'Nam · Bắc · Phong cách tin tức', 'https://cdn.yupvox.com/previews/preview_1787110608387_vtxa3l.wav'],
  ['VV0003', 'Minh Thư', 'female', 'Giọng nữ miền Nam: Phù hợp cho những nội dung review, hài hước', 'https://cdn.yupvox.com/previews/preview_1785635540809_t942xe.mp3'],
  ['VV0086', 'Khả Ngân', 'female', 'Giọng nữ trẻ: Nhịp điệu nhanh, năng động phong cách VJ. Thích hợp là…', 'https://cdn.yupvox.com/previews/preview_1785636567394_o3rod6.mp3'],
  ['DBD914', 'Cam', 'female', 'Young, energetic', 'https://resource.heygen.ai/text_to_speech/3JwsqfGcV3TvoziGzfqM9K.mp3'],
  ['VV0019', 'Trung Quân', 'male', 'Giọng nam miền Bắc: Ấm áp, điềm đặn và tròn vành rõ chữ. Thích hợp c…', 'https://cdn.yupvox.com/previews/preview_1785635729010_zbg61m.mp3'],
  ['EFC482', 'Anh Dũng', 'male', 'Youthful, modern, energetic', 'https://img01.reimgx.com/previews/preview_1784425224234_hamix.mp3'],
  ['VI0010', 'Thục Đoan', 'female', 'Nữ · Nam · Phong cách kể chuyện', 'https://cdn.yupvox.com/previews/preview_1787110991491_yf38kb.wav'],
  ['BAD084', 'Thu Hương', 'female', 'Older, mature', 'https://img01.reimgx.com/previews/preview_1784425234890_ljj29m.mp3'],
  ['VV0038', 'Nguyệt Ánh', 'female', 'Giọng nữ miền Bắc: Trung tính, tự sự và phát thanh chuẩn. Thích hợp…', 'https://cdn.yupvox.com/previews/preview_1785635958972_5imia.mp3'],
  ['F06966', 'Giọng Đọc Truyền Cảm', 'female', 'Chất giọng nữ trầm ấm, truyền cảm, phù hợp để kể chuyện và dẫn dắt n…', 'https://cdn.yupvox.com/voices/F06966.mp3'],
  ['VI0017', 'Đức Trí', 'male', 'Nam · Nam · Phong cách đọc truyện', 'https://cdn.yupvox.com/previews/preview_1787111277238_hhqd5f.wav'],
  ['VI0005', 'Thanh Bình', 'male', 'Nam · Bắc · Phong cách kể chuyện', 'https://cdn.yupvox.com/previews/preview_1787110761287_45gt1s.wav'],
  ['VV0065', 'Gia Khiêm', 'male', 'Giọng nam miền Nam: Trầm ấm, điềm đạm và lắng đọng. Tối ưu cho podca…', 'https://cdn.yupvox.com/previews/preview_1785636294618_628kc.mp3'],
  ['VV0046', 'Phương Thảo', 'female', 'Giọng nữ miền Bắc: Trẻ trung, ấm áp và đong đầy yêu thương. Chuyên d…', 'https://cdn.yupvox.com/previews/preview_1785636048705_3vf7r4.mp3'],
  ['CAF969', 'Bích', 'female', 'Young, energetic', 'https://resource.heygen.ai/text_to_speech/ew6DRo8i2QE6BnXEhUWHQ3.mp3'],
  ['VI0019', 'Ngọc Huyền', 'female', 'Nữ · Bắc · Giọng đọc tự nhiên', 'https://cdn.yupvox.com/previews/preview_1787111368439_oicmnt.wav'],
  ['VV0007', 'Cổ nhân', 'male', 'Giọng nam miền Bắc: Trầm tĩnh, cổ kính và trải đời. Thích hợp đọc tr…', 'https://cdn.yupvox.com/previews/preview_1785635579752_05k7wr.mp3'],
  ['F00231', 'Giọng Nam Trầm Ấm', 'male', 'Một giọng nam trầm ấm, điềm tĩnh, thích hợp cho việc kể chuyện và mi…', 'https://cdn.yupvox.com/voices/F00231.mp3'],
  ['F06846', 'Doraemon', 'female', 'Một giọng nữ trung niên, giàu cảm xúc và năng lượng, phù hợp cho các…', 'https://cdn.yupvox.com/voices/F06846.mp3'],
  ['VV0048', 'Bách Tùng', 'male', 'Giọng nam miền Bắc: Âm hưởng loa phường thập niên 80 hoài cổ. Chuyên…', 'https://cdn.yupvox.com/previews/preview_1785636076090_jd8qps.mp3'],
  ['VV0069', 'Anh Khoa', 'male', 'Giọng nam miền Nam: Mộc mạc, gần gũi và chân thật. Phù hợp cho vlog…', 'https://cdn.yupvox.com/previews/preview_1785636347238_1ovsmq.mp3'],
  ['EDB974', 'Chí', 'male', 'Young, energetic', 'https://resource.heygen.ai/text_to_speech/uFkZtUtRok6GsnpXhdJXJc.mp3'],
  ['VV0059', 'Tùng Sơn', 'male', 'Giọng nam miền Bắc: Trung trầm, gằn nhẹ và cá tính. Chuyên lồng tiến…', 'https://cdn.yupvox.com/previews/preview_1785636218086_b6n1eb.mp3'],
  ['VV0089', 'Bé Minh Anh', 'male', 'Giọng trẻ em (nam) miền Bắc: Hồn nhiên, ngây thơ và đáng yêu. Chuyên…', 'https://cdn.yupvox.com/previews/preview_1785636611065_vsl7y.mp3'],
  ['VV0075', 'Thế Phong', 'male', 'Giọng nam miền Nam: Ấm áp, sâu lắng và tràn đầy cảm xúc. Thích hợp đ…', 'https://cdn.yupvox.com/previews/preview_1785636424007_8tj23.mp3'],
  ['F05503', 'Giọng Nữ Năng Động', 'female', 'Đây là một giọng nữ trẻ trung, năng động, rất phù hợp cho các nội du…', 'https://cdn.yupvox.com/voices/F05503.mp3'],
  ['VV0020', 'Vy Tin Tức', 'female', 'Giọng nữ miền Bắc: Chuẩn mực, rõ lời và khách quan. Chuyên cho bản t…', 'https://cdn.yupvox.com/previews/preview_1785635744657_ip7x2.mp3'],
  ['BCB483', 'Huyền Anh', 'female', 'Young, energetic, and northerner', 'https://img01.reimgx.com/previews/preview_1784410070919_z5cf6f.mp3'],
  ['VV0066', 'An Chi', 'female', 'Giọng nữ miền Nam: Dịu dàng, nũng nịu và ngọt ngào. Phù hợp đọc truy…', 'https://cdn.yupvox.com/previews/preview_1785636307455_1ytasi.mp3'],
  ['EFC481', 'Tuyết Mai', 'female', 'Cute, sweet', 'https://img01.reimgx.com/previews/preview_1784425257403_20g13i.mp3'],
  ['VI0002', 'Phạm Tuyên', 'male', 'Nam · Bắc · Phong cách tự nhiên', 'https://cdn.yupvox.com/previews/preview_1787110638493_q801uo.wav'],
];

const VOICES: AiFieldOption[] = VOICE_LIST.map(([value, label, gender, desc]) => ({ value, label, gender, langs: ['vi'], tags: desc ? [desc] : [], badge: value }));

/** Link nghe thử theo mã giọng (chỉ giọng có trong danh sách) */
const VOICE_PREVIEWS = new Map(VOICE_LIST.map(([value, , , , url]) => [value, url]));

/** Giọng tách theo giới tính cho chế độ giọng nam + giọng nữ của lồng tiếng video */
const MALE_VOICES = VOICES.filter((v) => v.gender === 'male');
const FEMALE_VOICES = VOICES.filter((v) => v.gender === 'female');

/** Ô chọn giọng: hộp chọn có tìm kiếm, lọc giới tính và nghe thử */
const VOICE_PICKER = { type: 'select' as const, picker: 'voice' as const, preview: '/api/public/ai/voice-preview/yupvox/{value}' };

const VOICE_HELP = 'Bấm ▶ để nghe thử; cần giọng khác (hơn 3.000 giọng, nhiều ngôn ngữ) thì nhập mã giọng ở ô bên dưới';
const CUSTOM_VOICE = { name: 'voiceCode', label: 'Hoặc nhập mã giọng khác (tuỳ chọn)', type: 'text' as const, max: 20, placeholder: 'Ví dụ DFE237', help: 'Điền mã giọng thì bỏ qua giọng đã chọn ở trên' };
const AUDIO = 'audio/mpeg,audio/wav,audio/x-wav,audio/mp4,audio/x-m4a,video/mp4';

/** Ngôn ngữ cho STT / dịch phụ đề */
const LANGS = opts([
  ['vi', 'Tiếng Việt'],
  ['en', 'Tiếng Anh'],
  ['zh', 'Tiếng Trung'],
  ['ja', 'Tiếng Nhật'],
  ['ko', 'Tiếng Hàn'],
  ['th', 'Tiếng Thái'],
  ['id', 'Tiếng Indonesia'],
  ['es', 'Tiếng Tây Ban Nha'],
  ['fr', 'Tiếng Pháp'],
  ['de', 'Tiếng Đức'],
]);

/** File đầu vào của lồng tiếng video: video MP4 / MOV hoặc audio */
const MEDIA = `video/mp4,video/quicktime,${AUDIO.replace(',video/mp4', '')}`;

/** Lựa chọn có mô tả phụ (web hiện dạng thẻ 2 cột: nhãn đậm + mô tả nhỏ) */
const cards = (list: [string, string, string][]): AiFieldOption[] => list.map(([value, label, hint]) => ({ value, label, hint }));

/**
 * Các tuỳ chọn của Lồng tiếng & dịch video, lấy theo công cụ web yupvox.com/translate-video (31/10/2026):
 * web gửi voiceSource, subMaskMode, enableDelogo, targetRes, targetAspect — tài liệu API công khai chưa ghi các trường này.
 */
const VOICE_SOURCES = cards([
  ['auto', 'Lấy âm tự động (Mặc định)', 'Âm sẽ trong hơn, rõ ràng, không méo và nhiễu âm'],
  ['original', 'Lấy âm gốc của nhân vật (Gốc video)', 'Phù hợp với nhân vật đang nói, nhưng có thể bị méo, nhỏ'],
  ['manual', 'Chọn giọng đọc (Tự chọn)', 'Chọn giọng đọc yêu thích từ kho 3.500+ giọng chuẩn'],
]);

/** Kiểu che phụ đề gốc; `no_subtitle` = không chèn chữ, chỉ lồng tiếng */
const SUB_MASKS = cards([
  ['light_masked', 'Hộp mờ sáng ôm chữ (Khuyên dùng)', 'Hộp sáng mờ ôm khít từng dòng chữ, che sạch sub gốc viền sáng. Chuẩn TikTok & Anime.'],
  ['dark_full_masked', 'Dải đen rạp phim', 'Thanh đen mảnh ngang đáy màn hình đè phụ đề cũ, chữ trắng. Chuẩn phim ảnh.'],
  ['dark_masked', 'Hộp đen mờ ôm chữ', 'Hộp đen mờ ôm sát từng dòng chữ, chữ trắng nổi bật trên mọi nền sáng.'],
  ['light_full_masked', 'Dải trắng mảnh ngang', 'Thanh trắng mờ ngang đáy màn hình đè phụ đề cũ, chữ đen tương phản cao.'],
  ['none', 'Phụ đề nổi tiêu chuẩn', 'Chữ nổi viền đen, không vẽ hộp che (dành cho video không có sub gốc).'],
  ['no_subtitle', 'Tắt phụ đề (chỉ lồng tiếng)', 'Không chèn chữ vào video, chỉ lồng giọng đọc AI mới. Giữ nguyên 100% hình ảnh gốc.'],
]);

const RESOLUTIONS = cards([
  ['hd', 'HD 1080p (Khuyên dùng)', 'Sắc nét chuẩn studio, bitrate cao cho kênh chính'],
  ['sd', 'SD 480p (Siêu tốc)', 'Render nhanh x2, giảm 60% dung lượng, tải nhẹ'],
]);

const ASPECTS = cards([
  ['original', 'Tỉ lệ gốc', 'Giữ theo video tải lên'],
  ['9:16', '9:16 Dọc', 'TikTok, Reels, Shorts'],
  ['16:9', '16:9 Ngang', 'YouTube, Facebook, TV'],
  ['1:1', '1:1 Vuông', 'Instagram, Feed, Ads'],
]);

/** Số người nói tối đa của TTS hội thoại (ô chọn giọng A, B, C, D) */
const SPEAKERS = ['A', 'B', 'C', 'D'] as const;

/** Tên nhóm mẫu dựng video (hiện thành tab trong hộp chọn mẫu) */
const STYLE_GROUPS: Record<string, string> = {
  news: 'Tin tức',
  lifestyle: 'Đời sống',
  engage: 'Tương tác',
  minimal: 'Tối giản',
  tech: 'Công nghệ',
  explainer: 'Giải thích',
  product: 'Sản phẩm',
  saas: 'Thương hiệu',
};

/**
 * 80 mẫu dựng video của Tin tức thành video (stylePreset), lấy theo công cụ web yupvox.com/article-to-video (31/10/2026):
 * [mã mẫu, nhóm, tên, video mẫu trên cdn.tovid.app]. Ảnh bìa đã chép về web (apps/web/public/article-video/posters/<mã>.webp).
 */
const ARTICLE_STYLE_LIST: [string, string, string, string][] = [
  ['news_breaking', 'news', 'Bản tin truyền hình', 'news_breaking.mp4?v=1792235300729'],
  ['news_editorial', 'news', 'Tạp chí', 'news_editorial.mp4?v=1792235304027'],
  ['news_social_split', 'news', 'Mạng xã hội', 'news_social_split.mp4?v=1792235329275'],
  ['news_text_story', 'news', 'Chữ trên nền mờ', 'news_text_story.mp4?v=1792185072782'],
  ['news_listicle', 'news', 'Top N · Danh sách', 'news_listicle.mp4?v=1792185086046'],
  ['news_photo_story', 'news', 'Phóng sự ảnh', 'news_photo_story.mp4?v=1792185101797'],
  ['news_timeline', 'news', 'Dòng thời gian', 'news_timeline.mp4?v=1792185111487'],
  ['news_quote', 'news', 'Trích dẫn', 'news_quote.mp4?v=1792185126206'],
  ['news_sport_result', 'news', 'Thể thao · Kết quả', 'news_sport_result.mp4?v=1792235341091'],
  ['news_sport_ranking', 'news', 'Thể thao · Bảng xếp hạng', 'news_sport_ranking.mp4?v=1792235353712'],
  ['news_job_post', 'news', 'Tin tuyển dụng', 'news_job_post.mp4?v=1792235371420'],
  ['life_recipe', 'lifestyle', 'Công thức nấu ăn', 'life_recipe.mp4?v=1792235387949'],
  ['life_travel', 'lifestyle', 'Du lịch', 'life_travel.mp4?v=1792235404073'],
  ['life_health_tips', 'lifestyle', 'Mẹo sức khỏe', 'life_health_tips.mp4?v=1792235421442'],
  ['life_howto_steps', 'lifestyle', 'Hướng dẫn từng bước', 'life_howto_steps.mp4?v=1792235437806'],
  ['life_entertainment', 'lifestyle', 'Review giải trí', 'life_entertainment.mp4?v=1792235450877'],
  ['life_event', 'lifestyle', 'Sự kiện', 'life_event.mp4?v=1792235465416'],
  ['engage_quiz', 'engage', 'Đố vui', 'engage_quiz.mp4?v=1792235482325'],
  ['engage_did_you_know', 'engage', 'Bạn có biết?', 'engage_did_you_know.mp4?v=1792235498012'],
  ['engage_myth_fact', 'engage', 'Lầm tưởng – Sự thật', 'engage_myth_fact.mp4?v=1792235508212'],
  ['engage_social_post', 'engage', 'Bài đăng mạng xã hội', 'engage_social_post.mp4?v=1792235523885'],
  ['engage_countdown', 'engage', 'Đếm ngược tới #1', 'engage_countdown.mp4?v=1793390150077'],
  ['engage_poll', 'engage', 'Bình chọn A/B', 'engage_poll.mp4?v=1793390069047'],
  ['engage_guess', 'engage', 'Đoán xem', 'engage_guess.mp4?v=1793390079494'],
  ['engage_faq', 'engage', 'Hỏi nhanh đáp gọn', 'engage_faq.mp4?v=1793390086762'],
  ['news_football_match', 'news', 'Bóng đá · Kết quả trận', 'news_football_match.mp4?v=1792054785112'],
  ['news_football_transfer', 'news', 'Bóng đá · Chuyển nhượng', 'news_football_transfer.mp4?v=1792054810988'],
  ['news_football_stats', 'news', 'Bóng đá · Thống kê', 'news_football_stats.mp4?v=1792054812435'],
  ['news_realestate_project', 'news', 'Bất động sản · Dự án', 'news_realestate_project.mp4?v=1792054824691'],
  ['news_realestate_market', 'news', 'Bất động sản · Thị trường', 'news_realestate_market.mp4?v=1792054826195'],
  ['news_realestate_location', 'news', 'Bất động sản · Vị trí', 'news_realestate_location.mp4?v=1792054836912'],
  ['news_market_wrap', 'news', 'Tài chính · Điểm tin thị trường', 'news_market_wrap.mp4?v=1792054882025'],
  ['news_price_chart', 'news', 'Tài chính · Biểu đồ giá', 'news_price_chart.mp4?v=1792054900614'],
  ['news_crypto_spotlight', 'news', 'Tài chính · Tiêu điểm Crypto', 'news_crypto_spotlight.mp4?v=1792054902307'],
  ['news_stock_spotlight', 'news', 'Tài chính · Tiêu điểm cổ phiếu', 'news_stock_spotlight.mp4?v=1792054912958'],
  ['minimal_points', 'minimal', 'Ý chính', 'minimal_points.mp4?v=1792298012234'],
  ['minimal_stats', 'minimal', 'Con số', 'minimal_stats.mp4?v=1792298024113'],
  ['minimal_steps', 'minimal', 'Các bước', 'minimal_steps.mp4?v=1792298034892'],
  ['minimal_compare', 'minimal', 'So sánh', 'minimal_compare.mp4?v=1792298045440'],
  ['minimal_quote', 'minimal', 'Trích dẫn', 'minimal_quote.mp4?v=1792298061351'],
  ['minimal_timeline', 'minimal', 'Dòng thời gian', 'minimal_timeline.mp4?v=1792298070623'],
  ['minimal_ui', 'minimal', 'Giao diện phác thảo', 'minimal_ui.mp4?v=1792298085307'],
  ['minimal_auto', 'minimal', 'Tối giản tự động', 'minimal_auto.mp4?v=1792298099559'],
  ['minimal_points_dark', 'minimal', 'Ý chính (nền tối)', 'minimal_points_dark.mp4?v=1792298014419'],
  ['minimal_stats_dark', 'minimal', 'Con số (nền tối)', 'minimal_stats_dark.mp4?v=1792298025958'],
  ['minimal_steps_dark', 'minimal', 'Các bước (nền tối)', 'minimal_steps_dark.mp4?v=1792298036852'],
  ['minimal_compare_dark', 'minimal', 'So sánh (nền tối)', 'minimal_compare_dark.mp4?v=1792298047124'],
  ['minimal_quote_dark', 'minimal', 'Trích dẫn (nền tối)', 'minimal_quote_dark.mp4?v=1792298063375'],
  ['minimal_timeline_dark', 'minimal', 'Dòng thời gian (nền tối)', 'minimal_timeline_dark.mp4?v=1792298072331'],
  ['minimal_ui_dark', 'minimal', 'Giao diện phác thảo (nền tối)', 'minimal_ui_dark.mp4?v=1792298088178'],
  ['minimal_auto_dark', 'minimal', 'Tối giản tự động (nền tối)', 'minimal_auto_dark.mp4?v=1792298101321'],
  ['tech_cards', 'tech', 'Bento', 'tech_cards.mp4?v=1792054723305'],
  ['tech_code_editor', 'tech', 'Code Editor', 'tech_code_editor.mp4?v=1792054733397'],
  ['tech_spec_compare', 'tech', 'Thông số & So sánh', 'tech_spec_compare.mp4?v=1792054752856'],
  ['tech_github_launch', 'tech', 'GitHub Launch', 'tech_github_launch.mp4?v=1792054855927'],
  ['tech_tool_review', 'tech', 'Review công cụ / app', 'tech_tool_review.mp4?v=1793390097899'],
  ['tech_changelog', 'tech', 'Changelog', 'tech_changelog.mp4?v=1793390104034'],
  ['tech_keynote', 'tech', 'Keynote ra mắt', 'tech_keynote.mp4?v=1793390115560'],
  ['tech_explainer', 'explainer', 'Giải thích khái niệm', 'tech_explainer.mp4?v=1792054857103'],
  ['tech_explainer_blueprint', 'explainer', 'Bản vẽ kỹ thuật', 'tech_explainer_blueprint.mp4?v=1792054966219'],
  ['tech_explainer_hud', 'explainer', 'HUD viễn tưởng', 'tech_explainer_hud.mp4?v=1792054973279'],
  ['explainer_chalkboard', 'explainer', 'Bảng đen phấn trắng', 'explainer_chalkboard.mp4?v=1792185031865'],
  ['explainer_paper', 'explainer', 'Giấy cắt dán', 'explainer_paper.mp4?v=1792185021740'],
  ['explainer_isometric', 'explainer', 'Khối 3D isometric', 'explainer_isometric.mp4?v=1792185047889'],
  ['explainer_comic', 'explainer', 'Truyện tranh', 'explainer_comic.mp4?v=1792185063470'],
  ['explainer_flashcard', 'explainer', 'Thẻ học', 'explainer_flashcard.mp4?v=1792235530869'],
  ['product_showcase', 'product', 'Spotlight', 'product_showcase.mp4?v=1792054754873'],
  ['product_flash_sale', 'product', 'Flash Sale', 'product_flash_sale.mp4?v=1792054771864'],
  ['product_lookbook', 'product', 'Lookbook', 'product_lookbook.mp4?v=1792054774113'],
  ['product_reviews', 'product', 'Đánh giá khách hàng', 'product_reviews.mp4?v=1792054869046'],
  ['product_compare', 'product', 'So sánh / Trước–sau', 'product_compare.mp4?v=1792054871620'],
  ['product_top_list', 'product', 'Top N sản phẩm', 'product_top_list.mp4?v=1793390038760'],
  ['product_ugc', 'product', 'Kiểu người thật quay', 'product_ugc.mp4?v=1793390048037'],
  ['saas_intro', 'saas', 'Kinetic Type', 'saas_intro.mp4?v=1792054661908'],
  ['brand_ui_tour', 'saas', 'UI Tour', 'brand_ui_tour.mp4?v=1792054953843'],
  ['brand_logo_reveal', 'saas', 'Logo Reveal', 'brand_logo_reveal.mp4?v=1792054955250'],
  ['brand_social_proof', 'saas', 'Social proof', 'brand_social_proof.mp4?v=1792054919388'],
  ['brand_launch', 'saas', 'Ra mắt tính năng', 'brand_launch.mp4?v=1792054934827'],
  ['brand_problem_solution', 'saas', 'Vấn đề → Giải pháp', 'brand_problem_solution.mp4?v=1793390124531'],
  ['brand_pricing', 'saas', 'Bảng giá', 'brand_pricing.mp4?v=1793390129531'],
];

const ARTICLE_STYLES: AiFieldOption[] = ARTICLE_STYLE_LIST.map(([value, group, label, video]) => ({
  value,
  label,
  group: STYLE_GROUPS[group] ?? group,
  image: `/article-video/posters/${value}.webp`,
  video: `https://cdn.tovid.app/static/templates/${video}`,
}));

/** Giá cố định (credit YupVox) theo thời lượng video Tin tức thành video */
const ARTICLE_COST: Record<string, number> = { '30s': 10_000, '60s': 20_000, '90s': 25_000, '120s': 30_000 };

/**
 * Số ký tự tính phí chuẩn theo YupVox:
 * Nếu văn bản chứa chữ tượng hình Trung / Nhật / Hàn (CJK), toàn bộ chuỗi tính ×2,5 credit / ký tự; còn lại 1 credit / ký tự.
 */
const CJK_RE = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af]/;
const weightedChars = (text: string) => (CJK_RE.test(text) ? Math.ceil(text.length * 2.5) : text.length);

/** Tổng ký tự tính phí của kịch bản hội thoại nhiều giọng (đã bỏ tiền tố "A:", dòng trống; tính hệ số CJK từng câu) */
const dialogueChars = (script: string) => parseDialogue(script).reduce((n, b) => n + weightedChars(b.text), 0);

/** Tổng ký tự tính phí của Dịch phụ đề AI (nếu dịch sang Trung/Nhật/Hàn hoặc bản gốc có CJK đều tính ×2,5; song ngữ ×1,2 an toàn) */
function subtitleTranslateChars(input: AiInput): number {
  const clean = str(input.srtText)
    .split(/\r?\n/)
    .filter((l) => l.trim() && !/^\d+$/.test(l.trim()) && !/-->/.test(l) && l.trim() !== 'WEBVTT')
    .join('\n');
  const cjk = CJK_RE.test(clean) || ['zh', 'ja', 'ko'].includes(str(input.targetLang));
  const base = cjk ? Math.ceil(clean.length * 2.5) : clean.length;
  return input.bilingual === true ? Math.ceil(base * 1.2) : base;
}

const TOOLS: AiToolDef[] = [
  {
    key: 'tts',
    name: 'Chuyển văn bản thành giọng nói',
    category: 'giong-noi-ai',
    icon: 'audio-lines',
    featured: true,
    description: 'Đọc văn bản bằng giọng AI tiếng Việt tự nhiên: đọc truyện, review, tin tức, quảng cáo, TikTok.',
    output: 'audio',
    fields: [
      { name: 'text', label: 'Văn bản cần đọc', type: 'textarea', required: true, max: 50000, placeholder: 'Nhập hoặc dán nội dung...' },
      { name: 'voiceId', label: 'Giọng đọc', ...VOICE_PICKER, required: true, default: VOICES[0].value, options: VOICES, help: VOICE_HELP },
      CUSTOM_VOICE,
      { name: 'speed', label: 'Tốc độ đọc', type: 'number', default: 1, min: 0.5, max: 2, step: 0.05 },
    ],
    unitLabel: '1.000 ký tự',
    costPerUnit: 1000,
    priceHint: 'Tính chính xác theo số ký tự nhập (chữ Trung/Nhật/Hàn ×2,5)',
    units: (input) => (input.__sample ? 1 : weightedChars(str(input.text)) / 1000),
    pricing: { mode: 'cost', markup: 40, min: 100 },
  },
  {
    key: 'tts-dialogue',
    name: 'Hội thoại nhiều giọng AI',
    category: 'giong-noi-ai',
    icon: 'messages-square',
    badge: 'Mới',
    description: 'Viết kịch bản hội thoại tối đa 4 người nói, mỗi người một giọng AI. Xuất 1 file audio liền mạch kèm phụ đề .SRT.',
    output: 'audio',
    fields: [
      {
        name: 'script',
        label: 'Kịch bản hội thoại',
        type: 'textarea',
        required: true,
        max: 50000,
        placeholder: 'A: Chào bạn, hôm nay mình nói về chủ đề gì nhỉ?\nB: Hôm nay mình kể chuyện về AI nhé!\nA: Nghe hay đấy...',
        help: 'Mỗi dòng một câu, bắt đầu bằng A:, B:, C: hoặc D: để chọn người nói. Dòng không ghi người nói được đọc tiếp bằng giọng của dòng trước.',
      },
      ...SPEAKERS.map((s, i) => ({
        name: `voice${s}`,
        label: `Giọng người nói ${s}`,
        ...VOICE_PICKER,
        required: i < 2,
        // mặc định A nữ, B nam để nghe phân biệt ngay
        default: i === 0 ? 'DFE237' : i === 1 ? 'BEB861' : undefined,
        options: VOICES,
        help: i === 0 ? VOICE_HELP : undefined,
      })),
      { name: 'pause', label: 'Khoảng nghỉ giữa các câu (ms)', type: 'number', default: 300, min: 0, max: 5000, step: 50 },
      { name: 'speed', label: 'Tốc độ đọc', type: 'number', default: 1, min: 0.5, max: 2, step: 0.05 },
    ],
    unitLabel: '1.000 ký tự',
    costPerUnit: 1000,
    priceHint: 'Tính theo tổng ký tự lời thoại (bỏ tiền tố A:, B:)',
    units: (input) => (input.__sample ? 1 : dialogueChars(str(input.script)) / 1000),
    pricing: { mode: 'cost', markup: 40, min: 200 },
  },
  {
    key: 'subtitle-to-audio',
    name: 'Phụ đề SRT thành giọng đọc',
    category: 'giong-noi-ai',
    icon: 'scroll-text',
    description: 'Dán phụ đề .SRT, AI lồng tiếng khớp đúng mốc thời gian từng câu.',
    output: 'audio',
    fields: [
      { name: 'srtText', label: 'Nội dung phụ đề SRT', type: 'textarea', required: true, max: 100000, placeholder: '1\n00:00:01,000 --> 00:00:03,000\nXin chào các bạn...' },
      { name: 'voiceId', label: 'Giọng đọc', ...VOICE_PICKER, required: true, default: VOICES[0].value, options: VOICES, help: VOICE_HELP },
      CUSTOM_VOICE,
    ],
    unitLabel: '1.000 ký tự',
    costPerUnit: 1000,
    priceHint: 'Tính theo độ dài nội dung phụ đề SRT (chữ Trung/Nhật/Hàn ×2,5)',
    units: (input) => (input.__sample ? 1 : weightedChars(str(input.srtText)) / 1000),
    pricing: { mode: 'cost', markup: 40, min: 200 },
  },
  {
    key: 'stt',
    name: 'Chuyển giọng nói thành văn bản',
    category: 'giong-noi-ai',
    icon: 'mic',
    description: 'Tải file âm thanh / video lên, AI bóc băng thành văn bản hoặc phụ đề .SRT chính xác.',
    output: 'text',
    fields: [
      { name: 'audio', label: 'File âm thanh / video', type: 'audio', required: true, accept: AUDIO, help: 'MP3, WAV, M4A hoặc MP4 — hệ thống tự đo độ dài file để tính theo giây' },
      { name: 'language', label: 'Ngôn ngữ trong file', type: 'select', required: true, default: 'vi', options: LANGS },
      { name: 'srt', label: 'Xuất dạng phụ đề SRT (có mốc thời gian)', type: 'boolean', default: false },
    ],
    unitLabel: 'giây',
    costPerUnit: 10,
    priceHint: 'Tự đo độ dài file âm thanh / video tải lên',
    pricing: { mode: 'cost', markup: 40, min: 100 },
  },
  {
    key: 'voice-changer',
    name: 'Đổi giọng nói AI',
    category: 'giong-noi-ai',
    icon: 'replace',
    description: 'Đổi giọng người nói trong file âm thanh sang giọng AI bạn chọn: AI nghe lời nói rồi đọc lại bằng giọng mới.',
    output: 'audio',
    fields: [
      { name: 'audio', label: 'File âm thanh gốc', type: 'audio', required: true, accept: AUDIO, help: 'MP3, WAV, M4A hoặc MP4 — hệ thống tự đo độ dài file để tính theo giây' },
      { name: 'voiceId', label: 'Giọng AI muốn đổi sang', ...VOICE_PICKER, required: true, default: VOICES[0].value, options: VOICES, help: VOICE_HELP },
      CUSTOM_VOICE,
      { name: 'speed', label: 'Tốc độ', type: 'number', default: 1, min: 0.5, max: 2, step: 0.05 },
    ],
    unitLabel: 'giây',
    costPerUnit: 30,
    priceHint: 'Tự đo độ dài file âm thanh gốc (gồm bóc lời + tạo giọng AI mới)',
    pricing: { mode: 'cost', markup: 40, min: 200 },
  },
  {
    key: 'translate-subtitles',
    name: 'Dịch phụ đề AI',
    category: 'giong-noi-ai',
    icon: 'languages',
    description: 'Dịch file phụ đề SRT / VTT giữ nguyên mốc thời gian, câu dịch gọn theo thời lượng từng câu.',
    output: 'text',
    fields: [
      { name: 'srtText', label: 'Nội dung phụ đề SRT / VTT', type: 'textarea', required: true, max: 100000, placeholder: '1\n00:00:01,000 --> 00:00:03,500\nWelcome back to our channel!' },
      { name: 'targetLang', label: 'Dịch sang', type: 'select', required: true, default: 'vi', options: LANGS },
      { name: 'tone', label: 'Phong cách dịch', type: 'select', default: 'natural', options: opts([['natural', 'Tự nhiên'], ['formal', 'Trang trọng'], ['concise', 'Ngắn gọn']]) },
      { name: 'bilingual', label: 'Xuất phụ đề song ngữ', type: 'boolean', default: false },
    ],
    unitLabel: '1.000 ký tự',
    costPerUnit: 1000,
    priceHint: 'Tính theo số ký tự lời thoại (chữ Trung/Nhật/Hàn ×2,5)',
    units: (input) => (input.__sample ? 1 : subtitleTranslateChars(input) / 1000),
    pricing: { mode: 'cost', markup: 40, min: 200 },
  },
  {
    key: 'voice-cloning',
    name: 'Nhân bản giọng nói AI',
    category: 'giong-noi-ai',
    icon: 'mic',
    badge: 'Mới',
    description: 'Tải lên 10–30 giây giọng nói của bạn, AI tạo giọng riêng. Dùng mã giọng nhận được ở ô "Hoặc nhập mã giọng khác" của các công cụ đọc.',
    output: 'text',
    fields: [
      { name: 'voiceName', label: 'Tên giọng', type: 'text', required: true, max: 50, placeholder: 'Ví dụ: Giọng của tôi' },
      { name: 'audio', label: 'File giọng mẫu (10–30 giây, rõ lời, không nhạc nền)', type: 'audio', required: true, accept: AUDIO, help: 'MP3, WAV, M4A hoặc MP4' },
      { name: 'engine', label: 'Bộ máy nhân bản', type: 'select', default: 'alpha', options: opts([['alpha', 'Alpha — nhanh, tối ưu tiếng Việt'], ['omega', 'Omega — đa ngôn ngữ, chất lượng studio']]) },
      { name: 'language', label: 'Ngôn ngữ của giọng', type: 'select', default: 'Vietnamese', options: opts([['Vietnamese', 'Tiếng Việt'], ['English', 'Tiếng Anh'], ['Chinese', 'Tiếng Trung'], ['Japanese', 'Tiếng Nhật'], ['Korean', 'Tiếng Hàn']]) },
      { name: 'gender', label: 'Giới tính', type: 'select', default: 'Female', options: opts([['Female', 'Nữ'], ['Male', 'Nam']]) },
    ],
    unitLabel: 'lượt',
    pricing: { mode: 'fixed', base: 5000, min: 5000 },
  },
  {
    key: 'dubbing',
    name: 'Lồng tiếng AI (dịch audio / video)',
    category: 'giong-noi-ai',
    icon: 'clapperboard',
    badge: 'Mới',
    description: 'Tải audio / video lên, AI tự bóc băng, dịch sang ngôn ngữ khác và lồng tiếng bằng giọng AI bạn chọn.',
    output: 'audio',
    fields: [
      { name: 'audio', label: 'File audio / video gốc', type: 'audio', required: true, accept: AUDIO, help: 'MP3, WAV, M4A hoặc MP4' },
      { name: 'targetLang', label: 'Lồng tiếng sang', type: 'select', required: true, default: 'vi', options: LANGS },
      { name: 'voiceId', label: 'Giọng lồng tiếng', ...VOICE_PICKER, required: true, default: VOICES[0].value, options: VOICES, help: VOICE_HELP },
      CUSTOM_VOICE,
      { name: 'speed', label: 'Tốc độ', type: 'number', default: 1, min: 0.5, max: 2, step: 0.05 },
    ],
    unitLabel: 'giây',
    costPerUnit: 50,
    pricing: { mode: 'cost', markup: 40, min: 300 },
  },
  {
    key: 'video-dubbing',
    name: 'Lồng tiếng & dịch video AI',
    category: 'voice',
    icon: 'languages',
    badge: 'Mới',
    featured: true,
    description: 'Tải video lên, AI tách lời, dịch, lồng tiếng bằng giọng AI khớp mốc thời gian, che phụ đề gốc và xuất ra video mới kèm phụ đề.',
    output: 'video',
    fields: [
      { name: 'media', label: 'Video / audio gốc', type: 'video', required: true, accept: MEDIA, help: 'MP4, MOV hoặc MP3 / WAV / M4A, tối đa 1GB (60 phút). File âm thanh MP3/WAV/M4A được giảm 50% chi phí mỗi giây.' },
      { name: 'targetLang', label: 'Lồng tiếng sang', type: 'select', required: true, default: 'vi', options: LANGS },
      { name: 'sourceLang', label: 'Ngôn ngữ gốc', type: 'select', default: 'auto', options: [{ value: 'auto', label: 'Tự nhận diện' }, ...LANGS] },
      // --- Giọng đọc: 3 nguồn giống công cụ web YupVox ---
      { name: 'voiceSource', label: 'Giọng đọc', type: 'select', default: 'auto', options: VOICE_SOURCES },
      {
        name: 'voiceMode',
        label: 'Kiểu chọn giọng',
        type: 'select',
        default: 'single',
        options: opts([['single', 'Một giọng cho cả video'], ['pair', 'Giọng nam + giọng nữ (AI tự gán theo người nói)']]),
        showIf: { field: 'voiceSource', in: ['manual'] },
      },
      { name: 'voiceId', label: 'Giọng đọc', ...VOICE_PICKER, default: VOICES[0].value, options: VOICES, help: VOICE_HELP, showIf: { field: 'voiceMode', in: ['single'] } },
      { ...CUSTOM_VOICE, showIf: { field: 'voiceMode', in: ['single'] } },
      { name: 'maleVoiceId', label: 'Giọng cho người nói nam', ...VOICE_PICKER, default: 'BEB861', options: MALE_VOICES, showIf: { field: 'voiceMode', in: ['pair'] } },
      { name: 'femaleVoiceId', label: 'Giọng cho người nói nữ', ...VOICE_PICKER, default: 'DFE237', options: FEMALE_VOICES, showIf: { field: 'voiceMode', in: ['pair'] } },
      // --- Phụ đề (chỉ áp dụng cho file video) ---
      { name: 'subMaskMode', label: 'Phụ đề · Kiểu che phụ đề gốc', type: 'select', default: 'light_masked', options: SUB_MASKS, help: 'Chỉ áp dụng cho file video' },
      { name: 'enableDelogo', label: 'AI xoá mờ phụ đề gốc (tự phát hiện và làm mờ chữ cứng trên video)', type: 'boolean', default: false },
      // --- Định dạng & độ nét ---
      { name: 'targetRes', label: 'Độ nét & tốc độ render', type: 'select', default: 'hd', options: RESOLUTIONS },
      { name: 'targetAspect', label: 'Tỉ lệ khung hình xuất video', type: 'select', default: 'original', options: ASPECTS },
    ],
    unitLabel: 'giây',
    costPerUnit: 100,
    priceHint: 'Tính theo giây video tải lên (file audio MP3/WAV giảm 50%)',
    pricing: { mode: 'cost', markup: 40, min: 500 },
  },
  {
    key: 'article-to-video',
    name: 'Tin tức thành video',
    category: 'video',
    icon: 'newspaper',
    badge: 'Mới',
    featured: true,
    description: 'Dán link bài báo hoặc nội dung, AI viết kịch bản, đọc lời và dựng thành video tin tức MP4 hoàn chỉnh (TikTok, Reels, YouTube).',
    output: 'video',
    fields: [
      { name: 'url', label: 'Link bài báo', type: 'text', max: 2000, placeholder: 'https://vnexpress.net/...', help: 'Điền link bài báo hoặc dán nội dung ở ô bên dưới' },
      { name: 'text', label: 'Hoặc nội dung bài viết', type: 'textarea', max: 20000, placeholder: 'Dán nội dung tin tức / bài viết...' },
      { name: 'targetDuration', label: 'Thời lượng video', type: 'select', required: true, default: '60s', options: opts([['30s', '30 giây'], ['60s', '60 giây'], ['90s', '90 giây'], ['120s', '120 giây']]) },
      { name: 'aspectRatio', label: 'Tỉ lệ khung hình', type: 'select', required: true, default: '9:16', options: opts([['9:16', 'Dọc 9:16 (TikTok, Reels)'], ['16:9', 'Ngang 16:9 (YouTube)'], ['1:1', 'Vuông 1:1']]) },
      { name: 'language', label: 'Ngôn ngữ video', type: 'select', required: true, default: 'vi', options: LANGS },
      // hộp chọn mẫu có ảnh bìa + video xem trước, chia tab theo nhóm (picker 'template')
      { name: 'stylePreset', label: 'Mẫu dựng video', type: 'select', picker: 'template', required: true, default: 'news_editorial', options: ARTICLE_STYLES },
      // giọng tiếng Việt chọn + nghe thử trong hộp chọn; ngôn ngữ khác dùng giọng mặc định của ngôn ngữ đó (hoặc nhập mã giọng)
      { name: 'voiceId', label: 'Giọng đọc', ...VOICE_PICKER, default: 'VV0012', options: VOICES, help: VOICE_HELP, showIf: { field: 'language', in: ['vi'] } },
      { ...CUSTOM_VOICE, help: 'Điền mã giọng thì bỏ qua giọng đã chọn ở trên. Video ngôn ngữ khác tiếng Việt: bỏ trống để AI dùng giọng mặc định của ngôn ngữ đó' },
    ],
    unitLabel: 'video',
    priceHint: 'Giá theo mốc thời lượng chọn (30s / 60s / 90s / 120s)',
    pricing: { mode: 'cost', markup: 40, min: 7000 },
  },
];

/** Công cụ có tác vụ chạy nền và đường dẫn hỏi trạng thái (đổi giọng = STT + TTS; lồng tiếng nhanh khi API trả jobId) */
const POLL_PATHS: Record<string, string> = {
  tts: '/v1/tts',
  'tts-dialogue': '/v1/tts',
  'subtitle-to-audio': '/v1/tts',
  'voice-changer': '/v1/tts',
  dubbing: '/v1/tts',
  'video-dubbing': '/v1/video-dubbing',
  'article-to-video': '/v1/article-to-video',
};

/**
 * Tách kịch bản hội thoại thành các đoạn { speaker, text }: dòng "A: ..." đổi người nói,
 * dòng không có tiền tố đọc tiếp bằng người nói trước (mặc định A). Bỏ dòng trống.
 */
function parseDialogue(script: string) {
  const blocks: { speaker: (typeof SPEAKERS)[number]; text: string }[] = [];
  let speaker: (typeof SPEAKERS)[number] = 'A';
  for (const raw of script.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^([A-D])\s*[:：]\s*(.*)$/i.exec(line);
    if (m) speaker = m[1].toUpperCase() as (typeof SPEAKERS)[number];
    const text = (m ? m[2] : line).trim();
    if (text) blocks.push({ speaker, text });
  }
  return blocks;
}

/** Mốc ms -> "00:00:01,000" của SRT */
const srtTime = (ms: number) => {
  const t = Math.max(0, Math.round(ms));
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(Math.floor(t / 3_600_000))}:${p(Math.floor(t / 60_000) % 60)}:${p(Math.floor(t / 1000) % 60)},${p(t % 1000, 3)}`;
};

/** Dựng phụ đề SRT từ segments của STT */
const toSrt = (segments: any[]) =>
  segments
    .filter((g) => typeof g?.text === 'string' && g.text.trim())
    .map((g, i) => `${i + 1}\n${srtTime(Number(g.start_time))} --> ${srtTime(Number(g.end_time))}\n${g.text.trim()}\n`)
    .join('\n');

/** STT đồng bộ: bóc chữ từ file âm thanh / video (URL công khai) */
async function transcribe(ctx: AiCallContext, audioUrl: string, language: string) {
  const data = await call(ctx, '/v1/stt', { audioUrl, language: language || 'vi' });
  const text = typeof data?.textResult === 'string' ? data.textResult.trim() : '';
  return { data, text, segments: Array.isArray(data?.segments) ? data.segments : [] };
}

/** Bỏ envelope { success, data }; success = false -> lỗi (hết hạn mức phía YupVox: không lộ cho khách) */
function unwrap(res: any) {
  if (res && res.success === false) {
    const code = String(res.error?.code ?? '');
    const msg = /CREDIT|QUOTA|PLAN|LIMIT_EXCEEDED|API_KEY/i.test(code) ? 'Công cụ đang bảo trì, vui lòng thử lại sau. Credits đã được hoàn lại.' : pickMessage(res.error) || pickMessage(res) || 'YupVox báo lỗi';
    throw new AiProviderError(msg, res, /RATE_LIMIT|BUSY|TIMEOUT/i.test(code));
  }
  return res?.data ?? res;
}

const call = async (ctx: AiCallContext, path: string, json?: unknown) => unwrap(await providerFetch(ctx.config, path, json === undefined ? {} : { json }));

/** Giọng dùng: ô mã giọng tự nhập (nếu có) ưu tiên hơn ô chọn */
const voiceOf = (input: AiInput) => (str(input.voiceCode) || str(input.voiceId)).toUpperCase();

/** Link http(s) đầu tiên trong các trường có thể chứa kết quả */
const firstUrl = (...values: unknown[]) => values.find((v): v is string => typeof v === 'string' && /^https?:\/\//i.test(v.trim()));

/** Chuẩn hoá trạng thái job YupVox */
function toResult(tool: AiToolDef, id: string, job: any): AiProviderResult {
  const status = String(job?.status ?? '').toLowerCase();
  if (['failed', 'error', 'cancelled', 'canceled'].includes(status)) return { status: 'failed', providerTaskId: id, error: pickMessage(job) || job?.errorMessage || undefined, raw: job };
  if (!['completed', 'complete', 'success', 'succeeded', 'done'].includes(status)) return { status: 'processing', providerTaskId: id, progress: Number(job?.progress) || undefined, raw: job };

  const files: AiOutputFile[] = [];
  const audio = firstUrl(job.audioUrl, job.outputAudioUrl, job.convertedAudioUrl, job.dubbedAudioUrl, job.resultUrl, job.outputUrl, job.url, job.result?.audioUrl);
  if (audio && tool.output === 'audio') files.push({ url: audio, type: guessType(audio, 'audio') });
  if (tool.output === 'video') {
    // lồng tiếng video / tin tức thành video: file chính là videoUrl; lồng tiếng file audio thì chỉ có audioUrl
    const video = firstUrl(job.videoUrl, job.outputVideoUrl, job.result?.videoUrl);
    const main = video ?? audio;
    if (!main) return { status: 'failed', providerTaskId: id, error: 'Nhà cung cấp không trả file kết quả', raw: job };
    files.push({ url: main, type: guessType(main, video ? 'video' : 'audio') });
  }
  // phụ đề .srt đi kèm (TTS hội thoại, phụ đề -> audio, STT)
  const srt = firstUrl(job.outputSrtUrl, job.srtUrl, job.result?.srtUrl);
  if (srt) files.push({ url: srt, type: 'text', name: 'phu-de.srt' });

  if (tool.output === 'text') {
    const text = [job.text, job.transcript, job.transcription, job.resultText, job.result?.text, job.srtText].find((t) => typeof t === 'string' && t.trim());
    if (!text && !files.length) return { status: 'failed', providerTaskId: id, error: 'Nhà cung cấp không trả kết quả', raw: job };
    return { status: 'succeeded', providerTaskId: id, text: text ? String(text) : undefined, files, raw: job };
  }
  if (!files.some((f) => f.type !== 'text')) return { status: 'failed', providerTaskId: id, error: 'Nhà cung cấp không trả file kết quả', raw: job };
  return { status: 'succeeded', providerTaskId: id, files, raw: job };
}

/** File tải lên là audio (đuôi mp3 / wav / m4a…) -> lồng tiếng kiểu audio, giá 50 credit / giây */
const isAudioFile = (url: string) => guessType(url, 'video') === 'audio';

/** Thời lượng (giây) file khách tải lên — tính giá STT / đổi giọng / lồng tiếng (đọc từng phần, video tới 1GB) */
async function uploadSeconds(ctx: AiCallContext, url: unknown): Promise<number> {
  // chưa tải file (báo giá tạm trên form) -> tạm tính 10 giây (khớp resolveDurationSeconds)
  if (!str(url)) return 10;
  const sec = await ctx.uploadDuration(str(url));
  if (sec === null || !Number.isFinite(sec) || sec <= 0) throw new BadRequestException('Không đọc được độ dài file, vui lòng dùng MP3 / WAV / M4A hoặc MP4');
  return Math.max(1, Math.ceil(sec));
}

export const yupvoxProvider: AiProvider = {
  key: 'yupvox',
  name: 'YupVox',
  website: 'https://yupvox.com',
  // Tỉ giá an toàn không lỗ cho cả gói nhỏ nhất (Lite $2/99k ≈ 0,52đ -> bán kèm markup 40% = 0,70đ/credit; gói Pro chỉ ~0,19đ/credit lãi x3,7)
  costUnit: 'credit YupVox',
  rate: 0.5,
  tools: TOOLS,

  /**
   * Chi phí (credit YupVox chuẩn 100%, không bao giờ hụt vốn):
   * - Nhóm KÝ TỰ (TTS, Hội thoại, Phụ đề SRT, Dịch phụ đề): 1 credit / ký tự (chữ Trung/Nhật/Hàn CJK ×2,5 toàn chuỗi theo đúng YupVox).
   *   Khi bảng giá mặc định hỏi mẫu (`__sample: true`), trả 1.000 credit (= đơn giá 1.000 ký tự).
   * - Nhóm GIÂY (tự đo thời lượng thật của file tải lên, làm tròn lên giây):
   *   + STT: 10 credit / giây (an toàn cả khi nói dày / kèm dịch);
   *   + Đổi giọng (STT + TTS đọc lại): 30 credit / giây (an toàn cả tốc độ nói nhanh 25 ký tự/giây);
   *   + Lồng tiếng & dịch video: Video MP4/MOV = 100 credit / giây (tối thiểu 100), File Audio MP3/WAV/M4A = 50 credit / giây (tối thiểu 50).
   * - Tin tức thành video: giá cố định theo mốc thời lượng chọn (30s: 10.000 · 60s: 20.000 · 90s: 25.000 · 120s: 30.000).
   */
  async cost(tool, input, ctx) {
    const isSample = input.__sample === true;
    switch (tool.key) {
      case 'tts': {
        const chars = weightedChars(str(input.text));
        return isSample && !chars ? 1000 : chars;
      }
      case 'tts-dialogue': {
        const chars = dialogueChars(str(input.script));
        return isSample && !chars ? 1000 : chars;
      }
      case 'subtitle-to-audio': {
        const chars = weightedChars(str(input.srtText));
        return isSample && !chars ? 1000 : chars;
      }
      case 'translate-subtitles': {
        const chars = subtitleTranslateChars(input);
        return isSample && !chars ? 1000 : chars;
      }
      case 'video-dubbing': {
        const perSec = isAudioFile(str(input.media)) ? 50 : 100;
        return Math.max(perSec, perSec * (await uploadSeconds(ctx, input.media)));
      }
      case 'article-to-video':
        return ARTICLE_COST[str(input.targetDuration)] ?? ARTICLE_COST['60s'];
      case 'stt':
        return 10 * (await uploadSeconds(ctx, input.audio));
      case 'voice-changer':
        return 30 * (await uploadSeconds(ctx, input.audio));
      case 'dubbing':
        return (/\.mp4(\?|$)/i.test(str(input.audio)) ? 100 : 50) * (await uploadSeconds(ctx, input.audio));
    }
    return null;
  },

  async submit(tool, input: AiInput, ctx) {
    const speed = Number(input.speed);
    const speedOpt = speed && speed !== 1 ? { speed } : {};
    let data: any;
    switch (tool.key) {
      case 'tts':
        data = await call(ctx, '/v1/tts', { voiceId: voiceOf(input), text: str(input.text), ...speedOpt });
        break;
      case 'tts-dialogue': {
        // mỗi dòng kịch bản = 1 block; giọng theo người nói A–D, nghỉ sau mỗi câu (câu cuối không nghỉ)
        const lines = parseDialogue(str(input.script));
        if (!lines.length) throw new AiProviderError('Kịch bản hội thoại đang trống');
        if (lines.length > 500) throw new AiProviderError('Kịch bản tối đa 500 câu, vui lòng chia nhỏ');
        const pause = Math.min(5000, Math.max(0, Math.round(Number(input.pause ?? 300)) || 0));
        const blocks = lines.map((b, i) => {
          const voiceId = str(input[`voice${b.speaker}`]).toUpperCase();
          if (!voiceId) throw new AiProviderError(`Chưa chọn giọng cho người nói ${b.speaker}`);
          return { voiceId, text: b.text, pauseBefore: 0, pauseAfter: i === lines.length - 1 ? 0 : pause, speed: speed || 1 };
        });
        data = await call(ctx, '/v1/tts', { blocks });
        break;
      }
      case 'video-dubbing': {
        // gửi link file đã tải lên (mediaUrl), một ngôn ngữ đích -> một job
        const audio = isAudioFile(str(input.media));
        // tác vụ cũ (trước khi có ô Giọng đọc) chỉ có voiceMode single/multi: single = tự chọn giọng
        const source = str(input.voiceSource) || (str(input.voiceMode) === 'single' ? 'manual' : 'auto');
        const pick = (v: unknown, list: AiFieldOption[]) => (list.some((o) => o.value === str(v)) ? str(v) : list[0].value);
        // tự chọn giọng: một giọng (targetVoiceId) hoặc cặp giọng nam / nữ (maleVoiceId / femaleVoiceId) theo tài liệu API
        const voices =
          source !== 'manual'
            ? { voiceMode: 'multi' }
            : str(input.voiceMode) === 'pair'
              ? { voiceMode: 'multi', maleVoiceId: pick(input.maleVoiceId, MALE_VOICES), femaleVoiceId: pick(input.femaleVoiceId, FEMALE_VOICES) }
              : { voiceMode: 'single', targetVoiceId: voiceOf(input) };
        data = await call(ctx, '/v1/video-dubbing', {
          mediaUrl: str(input.media),
          targetLang: str(input.targetLang) || 'vi',
          sourceLang: str(input.sourceLang) || 'auto',
          toolType: audio ? 'audio' : 'video',
          voiceSource: source,
          ...voices,
          // phụ đề / định dạng chỉ có nghĩa với video; giá trị lạ thì về mặc định
          ...(audio
            ? {}
            : {
                subMaskMode: pick(input.subMaskMode, SUB_MASKS),
                enableDelogo: input.enableDelogo === true || input.enableDelogo === 'true',
                targetRes: pick(input.targetRes, RESOLUTIONS),
                targetAspect: pick(input.targetAspect, ASPECTS),
              }),
        });
        data = { ...data, jobId: data?.jobId ?? (Array.isArray(data?.jobIds) ? data.jobIds[0] : undefined) };
        break;
      }
      case 'article-to-video': {
        // có link thì AI đọc bài từ link, không thì dùng nội dung dán vào
        const url = str(input.url);
        const text = str(input.text);
        if (!url && !text) throw new AiProviderError('Vui lòng nhập link bài báo hoặc nội dung bài viết');
        if (url && !/^https?:\/\//i.test(url)) throw new AiProviderError('Link bài báo phải bắt đầu bằng http:// hoặc https://');
        const language = str(input.language) || 'vi';
        // mã giọng tự nhập ưu tiên; giọng chọn trong hộp chọn chỉ áp dụng cho video tiếng Việt (ô ẩn khi chọn ngôn ngữ khác)
        const voice = (str(input.voiceCode) || (language === 'vi' ? str(input.voiceId) : '')).toUpperCase();
        data = await call(ctx, '/v1/article-to-video', {
          ...(url ? { url } : { text }),
          targetDuration: ARTICLE_COST[str(input.targetDuration)] ? str(input.targetDuration) : '60s',
          aspectRatio: str(input.aspectRatio) || '9:16',
          language,
          // mẫu lạ (tác vụ cũ / sửa tay) thì về mẫu mặc định
          stylePreset: ARTICLE_STYLES.some((o) => o.value === str(input.stylePreset)) ? str(input.stylePreset) : 'news_editorial',
          ...(voice ? { voiceId: voice } : {}),
        });
        break;
      }
      case 'subtitle-to-audio':
        if (!str(input.srtText).includes('-->')) throw new AiProviderError('Nội dung không đúng định dạng phụ đề SRT');
        data = await call(ctx, '/v1/subtitle-to-audio', { srtText: str(input.srtText), voiceId: voiceOf(input) });
        break;
      case 'stt': {
        const r = await transcribe(ctx, str(input.audio), str(input.language));
        const text = input.srt === true && r.segments.length ? toSrt(r.segments) : r.text;
        if (!text) return { status: 'failed', error: 'Không nhận ra lời nói trong file', raw: r.data };
        return { status: 'succeeded', text, raw: { ...r.data, segments: undefined } };
      }
      case 'voice-changer': {
        // bước 1: bóc chữ; bước 2: đọc lại bằng giọng đích (hỏi trạng thái như TTS)
        const r = await transcribe(ctx, str(input.audio), 'vi');
        if (!r.text) return { status: 'failed', error: 'Không nhận ra lời nói trong file', raw: r.data };
        data = await call(ctx, '/v1/tts', { voiceId: voiceOf(input), text: r.text, ...speedOpt });
        break;
      }
      case 'translate-subtitles': {
        // đồng bộ, trả kết quả luôn
        const srt = str(input.srtText);
        if (!srt.includes('-->')) throw new AiProviderError('Nội dung không đúng định dạng phụ đề SRT / VTT');
        const res = await call(ctx, '/v1/translate-subtitles', { srtText: srt, targetLang: str(input.targetLang) || 'vi', sourceLang: 'auto', tone: str(input.tone) || 'natural' });
        const text = input.bilingual === true ? res?.bilingualSrtText : res?.srtText;
        if (typeof text !== 'string' || !text.trim()) throw new AiProviderError('Nhà cung cấp không trả bản dịch', res);
        return { status: 'succeeded', text, raw: { ...res, translatedBlocks: undefined, vttText: undefined } };
      }
      case 'voice-cloning': {
        // POST /v1/voice-cloning/create -> { voiceCode, status: ready }; giọng để private trong tài khoản YupVox của web
        const res = await call(ctx, '/v1/voice-cloning/create', {
          voiceName: str(input.voiceName).slice(0, 50),
          audioUrl: str(input.audio),
          engine: str(input.engine) || 'alpha',
          language: str(input.language) || 'Vietnamese',
          gender: str(input.gender) || 'Female',
          privacy: 'private',
        });
        const code = str(res?.voiceCode ?? res?.voiceId ?? res?.code);
        if (!code) throw new AiProviderError('Nhà cung cấp không trả mã giọng', res);
        return {
          status: 'succeeded',
          text: `Đã tạo giọng "${str(res?.voiceName) || str(input.voiceName)}".\nMã giọng: ${code}\n\nDán mã này vào ô "Hoặc nhập mã giọng khác" của công cụ Chuyển văn bản thành giọng nói, Phụ đề SRT thành giọng đọc, Đổi giọng hoặc Lồng tiếng để đọc bằng giọng của bạn.`,
          raw: res,
        };
      }
      case 'dubbing': {
        // POST /v1/dubbing: tài liệu trả audioUrl luôn (đồng bộ); nếu trả jobId thì hỏi trạng thái như TTS
        data = await call(ctx, '/v1/dubbing', { audioUrl: str(input.audio), targetLang: str(input.targetLang) || 'vi', targetVoiceId: voiceOf(input), ...speedOpt });
        if (!(data?.jobId ?? data?.id)) return toResult(tool, '', { status: 'completed', ...data });
        break;
      }
      default:
        throw new AiProviderError('Công cụ không được hỗ trợ');
    }
    const jobId = data?.jobId ?? data?.id;
    if (!jobId) throw new AiProviderError('Nhà cung cấp không trả mã tác vụ', data);
    return toResult(tool, String(jobId), { status: 'processing', ...data });
  },

  async poll(tool, id, ctx) {
    const path = POLL_PATHS[tool.key];
    if (!path) throw new AiProviderError('Công cụ không có tác vụ chạy nền');
    return toResult(tool, id, await call(ctx, `${path}/${encodeURIComponent(id)}`));
  },

  /** File nghe thử của giọng trong danh sách (API tải hộ, khách không thấy địa chỉ nhà cung cấp) */
  voicePreview: (voice) => VOICE_PREVIEWS.get(voice) ?? null,

  /** Số ký tự (credit) còn lại — GET /v1/me (remainChars) */
  async balance(ctx) {
    const me = await call(ctx, '/v1/me');
    const n = Number(me?.remainChars ?? me?.user?.remainChars ?? me?.credits);
    return Number.isFinite(n) ? { balance: n, unit: 'credit YupVox' } : null;
  },
};
