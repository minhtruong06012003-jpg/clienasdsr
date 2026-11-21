import { describe, expect, it } from 'vitest';
import { apiParams, canonicalModelSlug, slugModel, toInternalInput } from './ai-model-api.js';
import type { AiFieldDef } from './ai.types.js';

/** Form giống công cụ con theo model của TMC: ô model ẩn, lựa chọn thời lượng|độ phân giải và tỉ lệ phụ thuộc model */
const fields: AiFieldDef[] = [
  { name: 'model', label: 'Model AI', type: 'select', hidden: true, default: 'kling-2.6', options: [{ value: 'kling-2.6', label: 'Kling 2.6' }] },
  { name: 'image', label: 'Ảnh khung đầu', type: 'image', required: true },
  { name: 'refs', label: 'Ảnh tham chiếu', type: 'image', multiple: true, maxFiles: 4 },
  { name: 'prompt', label: 'Mô tả', type: 'textarea', max: 4000 },
  {
    name: 'option',
    label: 'Thời lượng / chất lượng',
    type: 'select',
    required: true,
    optionsBy: { field: 'model', map: { 'kling-2.6': [{ value: '5|720p', label: '5 giây · 720p' }, { value: '10|720p', label: '10 giây · 720p' }, { value: '5|1080p', label: '5 giây · 1080p' }], other: [{ value: '8|', label: '8 giây' }] } },
  },
  { name: 'aspectRatio', label: 'Tỉ lệ', type: 'select', optionsBy: { field: 'model', map: { 'kling-2.6': [{ value: '16:9', label: '16:9' }, { value: '9:16', label: '9:16' }] } } },
  { name: 'server', label: 'Máy chủ', type: 'select', options: [{ value: 's1', label: 'S1' }] },
];

describe('slugModel', () => {
  it('lấy phần tên model, bỏ mô tả và dấu', () => {
    expect(slugModel('Kling 2.6')).toBe('kling-2.6');
    expect(slugModel('ElevenLabs v3 (Giọng AI cao cấp)')).toBe('elevenlabs-v3');
    expect(slugModel('Google Lyria 2 · Nhạc giai điệu')).toBe('google-lyria-2');
    expect(slugModel('Kling 2.6 - Motion Control')).toBe('kling-2.6');
    expect(slugModel('Giọng Việt tự nhiên')).toBe('giong-viet-tu-nhien');
  });
});

describe('apiParams', () => {
  const params = apiParams(fields);
  it('đổi tên chuẩn, ẩn ô cố định, tách thời lượng / độ phân giải', () => {
    expect(params.map((p) => p.name)).toEqual(['image_url', 'reference_image_urls', 'prompt', 'duration', 'resolution', 'aspect_ratio']);
    expect(params.find((p) => p.name === 'duration')?.options?.map((o) => o.value)).toEqual(['5', '10']);
    expect(params.find((p) => p.name === 'resolution')?.options?.map((o) => o.value)).toEqual(['720p', '1080p']);
    // tỉ lệ phụ thuộc ô model đã ẩn -> rút gọn thành danh sách của đúng model
    expect(params.find((p) => p.name === 'aspect_ratio')?.options?.map((o) => o.value)).toEqual(['16:9', '9:16']);
    expect(params.find((p) => p.name === 'reference_image_urls')).toMatchObject({ type: 'file_url', multiple: true, max_files: 4 });
  });
});

describe('toInternalInput', () => {
  it('ghép tham số chuẩn về tên nội bộ', () => {
    const { input, unknown } = toInternalInput(fields, { image_url: 'u1', prompt: 'p', duration: 10, resolution: '720P', aspect_ratio: '9:16' });
    expect(unknown).toEqual([]);
    expect(input).toEqual({ model: 'kling-2.6', image: 'u1', prompt: 'p', option: '10|720p', aspectRatio: '9:16', server: 's1' });
  });
  it('vẫn nhận tên nội bộ cũ và báo tham số lạ', () => {
    const { input, unknown } = toInternalInput(fields, { image: 'u1', option: '5|1080p', promt: 'x' });
    expect(input).toMatchObject({ image: 'u1', option: '5|1080p' });
    expect(unknown).toEqual(['promt']);
  });
  it('báo lỗi tổ hợp không có', () => {
    expect(() => toInternalInput(fields, { duration: 10, resolution: '1080p' })).toThrow(/Các tổ hợp hợp lệ/);
  });
});

describe('canonicalModelSlug', () => {
  it('gộp các route lẻ cùng model khác server về đúng 1 canonical_model chuẩn', () => {
    expect(canonicalModelSlug('seedream-5.5', 'Seedream 5.5', 'image')).toBe('seedream-5.5');
    expect(canonicalModelSlug('seedream-5.5-2', 'Tạo & Ghép Ảnh Seedream 5.5 (1K – 4K)', 'image')).toBe('seedream-5.5');
    expect(canonicalModelSlug('seedream-5-5', 'Seedream 5.5 · Tách nền & 9 ảnh tham chiếu', 'image')).toBe('seedream-5.5');
    expect(canonicalModelSlug('seedream-5.5-3', 'Seedream 5.5 · Ảnh 1.5K/2K', 'image')).toBe('seedream-5.5');
    expect(canonicalModelSlug('wan-3-0', 'Wan 3.0 · Video 1080p', 'video')).toBe('wan-3.0');
    expect(canonicalModelSlug('wan-3.0/video', 'Wan 3.0', 'video')).toBe('wan-3.0');
    expect(canonicalModelSlug('gpt-image-2.5-sunburst/edit-3', 'GPT 2.5 Sunburst', 'chinh-sua-anh-ai')).toBe('gpt-image-2.5-sunburst/edit');
  });
});
