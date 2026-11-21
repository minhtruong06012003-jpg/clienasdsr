import { describe, expect, it } from 'vitest';
import { hasProviderBrandLeak, hideProviderText, sanitizeToolDisplayName } from './ai-public-key.js';

/** Chữ hiển thị cho khách không được lộ tên / link nhà cung cấp API AI */
describe('hideProviderText', () => {
  it('bỏ tên nhà cung cấp trong ngoặc ở tên công cụ', () => {
    expect(hideProviderText('Chuyển văn bản thành giọng nói (YupVox)')).toBe('Chuyển văn bản thành giọng nói');
    // tên có dấu cách ("IMG Studio") cũng phải che như tên viết liền
    expect(hideProviderText('Tạo ảnh AI (IMG Studio) · Muse Image')).toBe('Tạo ảnh AI · Muse Image');
    expect(hideProviderText('Tung Dang [11lab]')).toBe('Tung Dang');
  });

  it('bỏ link / tên miền nhà cung cấp', () => {
    expect(hideProviderText('Nghe thử ở yupvox.com/voices hoặc https://cdn.yupvox.com/a.mp3.')).toBe('Nghe thử ở hoặc.');
    expect(hideProviderText('Ảnh https://sangtaoai.blob.core.windows.net/x.webp')).toBe('Ảnh');
  });

  it('thay tên nhà cung cấp trong câu lỗi', () => {
    expect(hideProviderText('YupVox báo lỗi')).toBe('Hệ thống AI báo lỗi');
    expect(hideProviderText('AI DeepCut báo lỗi')).toBe('Hệ thống AI báo lỗi');
    expect(hideProviderText('TMC báo lỗi')).toBe('Hệ thống AI báo lỗi');
    expect(hideProviderText('Prism Forge báo lỗi tại https://prismforge.cloud/v1')).toBe('Hệ thống AI báo lỗi tại');
    expect(hideProviderText('Lỗi từ SangTao.ai: hết lượt')).toBe('Lỗi từ Hệ thống AI: hết lượt');
  });

  it('giữ nguyên chữ không có tên nhà cung cấp và giá trị rỗng', () => {
    expect(hideProviderText('Giọng ElevenLabs v3 · Kling 2.1')).toBe('Giọng ElevenLabs v3 · Kling 2.1');
    expect(hideProviderText(null)).toBe(null);
    expect(hideProviderText('')).toBe('');
  });
});

describe('sanitizeToolDisplayName', () => {
  it('tự gỡ sạch ký tự / thương hiệu / tên miền nguồn khỏi tên công cụ mà không chèn Hệ thống AI', () => {
    expect(hasProviderBrandLeak('Sửa ảnh AI (IMG Studio)')).toBe(true);
    expect(sanitizeToolDisplayName('Sửa ảnh AI (IMG Studio)')).toBe('Sửa ảnh AI');
    expect(sanitizeToolDisplayName('Tạo ảnh AI (IMG Studio) · GPT Image 2.5 Sunburst')).toBe('Tạo ảnh AI · GPT Image 2.5 Sunburst');
    expect(sanitizeToolDisplayName('79AI - Tạo video Kling 3.0')).toBe('Tạo video Kling 3.0');
    expect(sanitizeToolDisplayName('Tạo video Kling 3.0 · GoMMO')).toBe('Tạo video Kling 3.0');
    expect(sanitizeToolDisplayName('Seedance 2.0 Fast (maivideo.top)')).toBe('Seedance 2.0 Fast');
    expect(sanitizeToolDisplayName('Flux 2 Pro - botsd.pro')).toBe('Flux 2 Pro');
    expect(sanitizeToolDisplayName('Tung Dang [11lab]')).toBe('Tung Dang');
  });

  it('giữ nguyên 100% tên công cụ và model chuẩn không dính nguồn', () => {
    expect(hasProviderBrandLeak('Tạo video AI · Kling 3.0 Master')).toBe(false);
    expect(sanitizeToolDisplayName('Tạo video AI · Kling 3.0 Master')).toBe('Tạo video AI · Kling 3.0 Master');
    expect(sanitizeToolDisplayName('ElevenLabs Multilingual v2')).toBe('ElevenLabs Multilingual v2');
  });
});
