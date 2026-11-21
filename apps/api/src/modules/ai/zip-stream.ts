import { once } from 'node:events';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable, type Writable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { crc32, createDeflateRaw } from 'node:zlib';

/** Một file đầu vào để đóng gói vào luồng .ZIP */
export interface ZipSourceEntry {
  /** Tên file bên trong .ZIP (UTF-8, không có ký tự nguy hiểm) */
  name: string;
  /** Thời điểm sửa đổi hiển thị khi giải nén */
  mtime?: Date;
  /** Đường dẫn tuyệt đối trên ổ đĩa local (ưu tiên: đọc dạng luồng STORE 0-RAM) */
  localFile?: string | null;
  /** Hàm đọc Buffer từ S3 / bộ nhớ (khi không dùng storage local) */
  getBuffer?: () => Promise<Buffer | null>;
  /** Link nguồn từ xa khi file chưa sao lưu về storage */
  remoteUrl?: string | null;
}

interface CentralDirRecord {
  nameBytes: Buffer;
  flags: number;
  method: number;
  dosTime: number;
  dosDate: number;
  crc: number;
  compSize: number;
  uncompSize: number;
  offset: number;
}

/** Chuyển Date sang cặp (dosTime, dosDate) chuẩn PKZIP */
function toDosDateTime(date: Date = new Date()): { dosTime: number; dosDate: number } {
  const y = Math.min(2107, Math.max(1980, date.getFullYear()));
  const dosTime = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((date.getSeconds() >> 1) & 0x1f);
  const dosDate = (((y - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0x0f) << 5) | (date.getDate() & 0x1f);
  return { dosTime, dosDate };
}

/** Làm sạch tên file trong .ZIP: bỏ đường dẫn ngược (`..`), dấu `/` đầu */
function cleanEntryName(raw: string, fallback: string): string {
  const cleaned = raw
    .replace(/\\/g, '/')
    .split('/')
    .map((seg) => seg.replace(/[:*?"<>|\x00-\x1f]+/g, '_').trim())
    .filter((seg) => seg && seg !== '.' && seg !== '..')
    .join('/');
  return cleaned || fallback;
}

function buildLocalHeader(nameBytes: Buffer, flags: number, method: number, dosTime: number, dosDate: number, crc: number, compSize: number, uncompSize: number): Buffer {
  const buf = Buffer.allocUnsafe(30 + nameBytes.length);
  buf.writeUInt32LE(0x04034b50, 0);
  buf.writeUInt16LE(20, 4); // PKZIP 2.0
  buf.writeUInt16LE(flags, 6);
  buf.writeUInt16LE(method, 8);
  buf.writeUInt16LE(dosTime, 10);
  buf.writeUInt16LE(dosDate, 12);
  buf.writeUInt32LE(crc >>> 0, 14);
  buf.writeUInt32LE(compSize >>> 0, 18);
  buf.writeUInt32LE(uncompSize >>> 0, 22);
  buf.writeUInt16LE(nameBytes.length, 26);
  buf.writeUInt16LE(0, 28);
  nameBytes.copy(buf, 30);
  return buf;
}

function buildCentralHeader(r: CentralDirRecord): Buffer {
  const buf = Buffer.allocUnsafe(46 + r.nameBytes.length);
  buf.writeUInt32LE(0x02014b50, 0);
  buf.writeUInt16LE(20, 4);
  buf.writeUInt16LE(20, 6);
  buf.writeUInt16LE(r.flags, 8);
  buf.writeUInt16LE(r.method, 10);
  buf.writeUInt16LE(r.dosTime, 12);
  buf.writeUInt16LE(r.dosDate, 14);
  buf.writeUInt32LE(r.crc >>> 0, 16);
  buf.writeUInt32LE(r.compSize >>> 0, 20);
  buf.writeUInt32LE(r.uncompSize >>> 0, 24);
  buf.writeUInt16LE(r.nameBytes.length, 28);
  buf.writeUInt16LE(0, 30);
  buf.writeUInt16LE(0, 32);
  buf.writeUInt16LE(0, 34);
  buf.writeUInt16LE(0, 36);
  buf.writeUInt32LE(0, 38);
  buf.writeUInt32LE(r.offset >>> 0, 42);
  r.nameBytes.copy(buf, 46);
  return buf;
}

/**
 * Đóng gói danh sách file thành luồng .ZIP trực tiếp ra `out` (0-RAM cho file trên đĩa local):
 * - File local / S3 buffer: ghi STORE (method = 0, cờ UTF-8 0x0800) kèm kích thước & CRC32 chính xác ngay ở Local Header,
 *   tương thích 100% mọi trình giải nén (Windows Explorer, macOS, iPhone Files, Android, WinRAR, 7-Zip) mà không tốn CPU nén lại video/ảnh.
 * - File remote chưa sao lưu: nén nhanh DEFLATE level 1 (method = 8, cờ 0x0808 kèm Data Descriptor) để truyền thẳng một lượt.
 * Trả về số file đã đóng gói thành công.
 */
export async function streamZipArchive(out: Writable, entries: ZipSourceEntry[], isAborted?: () => boolean): Promise<number> {
  let offset = 0;
  const records: CentralDirRecord[] = [];
  const MAX_ZIP32 = 0xf0000000; // ~3.75 GB ngưỡng an toàn của chuẩn ZIP 32-bit

  const writeChunk = async (chunk: Buffer) => {
    if (!chunk.length) return;
    if (isAborted?.() || out.destroyed) throw new Error('CLIENT_ABORTED');
    const ok = out.write(chunk);
    offset += chunk.length;
    if (!ok && !out.destroyed && !isAborted?.()) {
      await once(out, 'drain');
    }
  };

  try {
    for (let idx = 0; idx < entries.length; idx++) {
    if (isAborted?.() || out.destroyed) break;
    if (records.length >= 65000 || offset >= MAX_ZIP32) break;

    const entry = entries[idx];
    const safeName = cleanEntryName(entry.name, `file-${idx + 1}`);
    const nameBytes = Buffer.from(safeName, 'utf8');
    const { dosTime, dosDate } = toDosDateTime(entry.mtime);

    // 1. Ưu tiên file trên đĩa local: tính nhanh CRC32 theo luồng rồi gửi nguyên bản (STORE)
    if (entry.localFile) {
      const st = await stat(entry.localFile).catch(() => null);
      if (st?.isFile() && offset + st.size + 1024 < MAX_ZIP32) {
        const size = st.size;
        let crc = 0;
        if (size > 0) {
          let rem = size;
          const crcStream = createReadStream(entry.localFile, { highWaterMark: 256 * 1024, end: size - 1 });
          for await (const raw of crcStream) {
            if (isAborted?.() || out.destroyed) {
              crcStream.destroy();
              return records.length;
            }
            const buf = (raw as Buffer).length > rem ? (raw as Buffer).subarray(0, rem) : (raw as Buffer);
            crc = crc32(buf, crc);
            rem -= buf.length;
            if (rem <= 0) break;
          }
        }
        const entryOffset = offset;
        const flags = 0x0800; // UTF-8
        await writeChunk(buildLocalHeader(nameBytes, flags, 0, dosTime, dosDate, crc, size, size));
        if (size > 0) {
          let rem = size;
          const dataStream = createReadStream(entry.localFile, { highWaterMark: 256 * 1024, end: size - 1 });
          for await (const raw of dataStream) {
            if (isAborted?.() || out.destroyed) {
              dataStream.destroy();
              return records.length;
            }
            const buf = (raw as Buffer).length > rem ? (raw as Buffer).subarray(0, rem) : (raw as Buffer);
            await writeChunk(buf);
            rem -= buf.length;
            if (rem <= 0) break;
          }
          // phòng hờ file bị cắt ngắn bất thường giữa 2 lần đọc: bù 0 để không lệch offset ZIP
          if (rem > 0) await writeChunk(Buffer.alloc(rem));
        }
        records.push({ nameBytes, flags, method: 0, dosTime, dosDate, crc, compSize: size, uncompSize: size, offset: entryOffset });
        continue;
      }
    }

    // 2. Driver S3 (đọc Buffer từ storage)
    if (entry.getBuffer) {
      const buf = await entry.getBuffer().catch(() => null);
      if (buf && offset + buf.length + 1024 < MAX_ZIP32) {
        const crc = crc32(buf, 0);
        const entryOffset = offset;
        const flags = 0x0800;
        await writeChunk(buildLocalHeader(nameBytes, flags, 0, dosTime, dosDate, crc, buf.length, buf.length));
        await writeChunk(buf);
        records.push({ nameBytes, flags, method: 0, dosTime, dosDate, crc, compSize: buf.length, uncompSize: buf.length, offset: entryOffset });
        continue;
      }
    }

    // 3. Dự phòng: file từ URL nhà cung cấp chưa sao lưu -> truyền thẳng qua DEFLATE level 1 + Data Descriptor
    if (entry.remoteUrl) {
      const upstream = await fetch(entry.remoteUrl, { signal: AbortSignal.timeout(10 * 60_000) }).catch(() => null);
      if (!upstream?.ok || !upstream.body) continue;
      const entryOffset = offset;
      const flags = 0x0808; // UTF-8 + Data Descriptor
      await writeChunk(buildLocalHeader(nameBytes, flags, 8, dosTime, dosDate, 0, 0, 0));

      let crc = 0;
      let uncompSize = 0;
      let compSize = 0;
      const deflater = createDeflateRaw({ level: 1 });
      const pumpOut = (async () => {
        for await (const comp of deflater) {
          const b = comp as Buffer;
          compSize += b.length;
          await writeChunk(b);
        }
      })();
      try {
        const src = Readable.fromWeb(upstream.body as unknown as WebReadableStream);
        for await (const raw of src) {
          if (isAborted?.() || out.destroyed) {
            src.destroy();
            deflater.destroy();
            return records.length;
          }
          const b = raw as Buffer;
          crc = crc32(b, crc);
          uncompSize += b.length;
          if (!deflater.write(b)) await once(deflater, 'drain');
        }
        deflater.end();
        await pumpOut;
      } catch {
        deflater.destroy();
        await pumpOut.catch(() => undefined);
        return records.length;
      }

      const dd = Buffer.allocUnsafe(16);
      dd.writeUInt32LE(0x08074b50, 0);
      dd.writeUInt32LE(crc >>> 0, 4);
      dd.writeUInt32LE(compSize >>> 0, 8);
      dd.writeUInt32LE(uncompSize >>> 0, 12);
      await writeChunk(dd);
      records.push({ nameBytes, flags, method: 8, dosTime, dosDate, crc, compSize, uncompSize, offset: entryOffset });
    }
  }

  if (isAborted?.() || out.destroyed) return records.length;

  const cdStart = offset;
  for (const r of records) {
    await writeChunk(buildCentralHeader(r));
  }
  const cdSize = offset - cdStart;

  const eocd = Buffer.allocUnsafe(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(records.length, 8);
  eocd.writeUInt16LE(records.length, 10);
  eocd.writeUInt32LE(cdSize >>> 0, 12);
  eocd.writeUInt32LE(cdStart >>> 0, 16);
  eocd.writeUInt16LE(0, 20);
    await writeChunk(eocd);

    return records.length;
  } catch (err) {
    if ((err as Error)?.message === 'CLIENT_ABORTED') return records.length;
    throw err;
  }
}
