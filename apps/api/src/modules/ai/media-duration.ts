import { open, type FileHandle } from 'node:fs/promises';

/**
 * Đọc thời lượng (giây) của file media khách tải lên, không cần ffmpeg.
 * Dùng để tính giá các công cụ tính phí theo độ dài file đầu vào (vd Kling Avatar theo độ dài giọng,
 * Motion Control theo độ dài video mẫu). Hỗ trợ MP4/MOV/M4A (hộp mvhd), WAV và MP3 (Xing/VBRI hoặc CBR).
 * Trả null khi không nhận ra định dạng.
 */
export function mediaDuration(buf: Buffer): number | null {
  if (buf.length < 12) return null;
  const tag = buf.toString('latin1', 4, 8);
  if (tag === 'ftyp' || tag === 'moov' || tag === 'mdat' || tag === 'wide' || tag === 'free') return mp4Duration(buf);
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WAVE') return wavDuration(buf);
  return mp3Duration(buf);
}

/** Duyệt các hộp ISO BMFF trong [start, end), gọi `fn` với (loại hộp, vị trí dữ liệu, vị trí kết thúc) */
function eachBox(buf: Buffer, start: number, end: number, fn: (type: string, body: number, stop: number) => boolean | void) {
  let pos = start;
  while (pos + 8 <= end) {
    let size = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    let body = pos + 8;
    if (size === 1) {
      // kích thước 64-bit nằm ngay sau loại hộp
      if (pos + 16 > end) return;
      size = Number(buf.readBigUInt64BE(pos + 8));
      body = pos + 16;
    } else if (size === 0) size = end - pos; // hộp kéo tới hết file
    if (size < 8) return;
    const stop = Math.min(pos + size, end);
    if (fn(type, body, stop)) return;
    pos += size;
  }
}

/** MP4 / MOV / M4A: moov › mvhd chứa timescale + duration */
function mp4Duration(buf: Buffer): number | null {
  let out: number | null = null;
  eachBox(buf, 0, buf.length, (type, body, stop) => {
    if (type !== 'moov') return;
    eachBox(buf, body, stop, (t, b) => {
      if (t !== 'mvhd' || b + 32 > buf.length) return;
      const v1 = buf[b] === 1;
      const timescale = buf.readUInt32BE(b + (v1 ? 20 : 12));
      const duration = v1 ? Number(buf.readBigUInt64BE(b + 24)) : buf.readUInt32BE(b + 16);
      if (timescale > 0) out = duration / timescale;
      return true;
    });
    return true;
  });
  return out;
}

/** WAV: kích thước chunk data ÷ byteRate trong chunk fmt (`total` = dung lượng cả file khi chỉ đọc phần đầu) */
function wavDuration(buf: Buffer, total = buf.length): number | null {
  let byteRate = 0;
  let dataSize = 0;
  let pos = 12;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('latin1', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    if (id === 'fmt ' && pos + 16 <= buf.length) byteRate = buf.readUInt32LE(pos + 16);
    if (id === 'data') {
      // một số file ghi size = 0/0xFFFFFFFF khi ghi luồng -> lấy phần còn lại của file
      dataSize = size && pos + 8 + size <= total ? size : total - pos - 8;
      break;
    }
    pos += 8 + size + (size % 2);
  }
  return byteRate > 0 && dataSize > 0 ? dataSize / byteRate : null;
}

const MP3_BITRATES = {
  v1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  v2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const MP3_RATES: Record<number, number[]> = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

/**
 * MP3 (Layer III): đọc frame đầu; có Xing/Info/VBRI thì lấy số frame, không thì ước lượng theo bitrate (CBR).
 * `total` / `tail`: dung lượng cả file và có thẻ ID3v1 128 byte cuối không — khi chỉ đọc phần đầu file.
 */
function mp3Duration(buf: Buffer, total = buf.length, tailTag?: boolean): number | null {
  let pos = 0;
  // bỏ thẻ ID3v2 (kích thước dạng syncsafe)
  if (buf.toString('latin1', 0, 3) === 'ID3' && buf.length > 10) {
    pos = 10 + ((buf[6] & 0x7f) << 21 | (buf[7] & 0x7f) << 14 | (buf[8] & 0x7f) << 7 | (buf[9] & 0x7f));
  }
  // tìm frame sync hợp lệ đầu tiên
  const limit = Math.min(buf.length - 4, pos + 64 * 1024);
  for (; pos < limit; pos++) {
    if (buf[pos] !== 0xff || (buf[pos + 1] & 0xe0) !== 0xe0) continue;
    const ver = (buf[pos + 1] >> 3) & 3; // 3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5
    const layer = (buf[pos + 1] >> 1) & 3; // 1 = Layer III
    const brIdx = buf[pos + 2] >> 4;
    const srIdx = (buf[pos + 2] >> 2) & 3;
    if (ver === 1 || layer !== 1 || brIdx === 0 || brIdx === 15 || srIdx === 3) continue;
    const sampleRate = MP3_RATES[ver][srIdx];
    const bitrate = (ver === 3 ? MP3_BITRATES.v1 : MP3_BITRATES.v2)[brIdx] * 1000;
    const samples = ver === 3 ? 1152 : 576;
    const mono = buf[pos + 3] >> 6 === 3;
    // Xing / Info nằm sau phần side info
    const xing = pos + 4 + (ver === 3 ? (mono ? 17 : 32) : mono ? 9 : 17);
    const xtag = buf.toString('latin1', xing, xing + 4);
    if ((xtag === 'Xing' || xtag === 'Info') && xing + 12 <= buf.length && buf[xing + 7] & 1) return (buf.readUInt32BE(xing + 8) * samples) / sampleRate;
    // VBRI (Fraunhofer) luôn ở vị trí cố định 32 byte sau header
    if (buf.toString('latin1', pos + 36, pos + 40) === 'VBRI' && pos + 54 <= buf.length) return (buf.readUInt32BE(pos + 36 + 14) * samples) / sampleRate;
    // CBR: phần còn lại của file (trừ thẻ ID3v1 128 byte cuối nếu có) ÷ bitrate
    const tag = tailTag ?? (buf.length >= 128 && buf.toString('latin1', buf.length - 128, buf.length - 125) === 'TAG');
    return ((total - pos - (tag ? 128 : 0)) * 8) / bitrate;
  }
  return null;
}

/** Phần đầu file đọc để nhận dạng (đủ cho header WAV / MP3 kể cả thẻ ID3v2 có ảnh bìa vừa phải) */
const HEAD_BYTES = 1024 * 1024;
/** Hộp moov tối đa chịu đọc (video 60 phút thường vài MB) */
const MAX_MOOV_BYTES = 200 * 1024 * 1024;

/** Đọc `len` byte tại vị trí `pos` của file đang mở */
async function readAt(fh: FileHandle, pos: number, len: number) {
  const buf = Buffer.alloc(len);
  const { bytesRead } = await fh.read(buf, 0, len, pos);
  return buf.subarray(0, bytesRead);
}

/**
 * Như mediaDuration nhưng đọc thẳng từ file trên đĩa, chỉ đọc phần cần thiết (file video lớn tới 1GB):
 * MP4 / MOV duyệt header các hộp cấp ngoài cùng để tìm moov (thường nằm cuối file) rồi chỉ đọc hộp đó;
 * WAV / MP3 đọc 1MB đầu + dung lượng file.
 */
export async function mediaDurationFile(file: string): Promise<number | null> {
  const fh = await open(file, 'r');
  try {
    const { size } = await fh.stat();
    const head = await readAt(fh, 0, Math.min(size, HEAD_BYTES));
    if (head.length < 12) return null;
    const tag = head.toString('latin1', 4, 8);
    if (['ftyp', 'moov', 'mdat', 'wide', 'free'].includes(tag)) {
      // duyệt hộp cấp ngoài: chỉ đọc 16 byte header mỗi hộp, nhảy qua phần dữ liệu (mdat rất lớn)
      let pos = 0;
      while (pos + 8 <= size) {
        const h = await readAt(fh, pos, 16);
        if (h.length < 8) return null;
        let box = h.readUInt32BE(0);
        if (box === 1 && h.length >= 16) box = Number(h.readBigUInt64BE(8));
        else if (box === 0) box = size - pos;
        if (box < 8) return null;
        if (h.toString('latin1', 4, 8) === 'moov') {
          if (box > MAX_MOOV_BYTES) return null;
          return mp4Duration(await readAt(fh, pos, Math.min(box, size - pos)));
        }
        pos += box;
      }
      return null;
    }
    if (head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WAVE') return wavDuration(head, size);
    const last = size >= 128 ? await readAt(fh, size - 128, 3) : Buffer.alloc(0);
    return mp3Duration(head, size, last.toString('latin1') === 'TAG');
  } finally {
    await fh.close();
  }
}
