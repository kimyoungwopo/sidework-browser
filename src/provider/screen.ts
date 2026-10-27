import type { ScreenFrame } from '../contract';
import { inflateSync } from 'node:zlib';

function invalid(): never { throw new Error('Invalid screen PNG image/frame bounds.'); }
function crc(bytes: Buffer): number {
  let c = 0xffffffff;
  for (const byte of bytes) { c ^= byte; for (let i = 0; i < 8; i++) c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0); }
  return (c ^ 0xffffffff) >>> 0;
}
/** Decode only bounded, intact, non-interlaced PNG captures; never trust metadata alone. */
export function screenPNG(frame: ScreenFrame | undefined): Buffer {
  if (!frame || typeof frame.frameId !== 'string' || !frame.frameId.trim() || frame.frameId.length > 200) invalid();
  for (const n of [frame.width, frame.height, frame.viewportWidth, frame.viewportHeight]) if (!Number.isSafeInteger(n) || n <= 0) invalid();
  if (frame.width > 1280 || frame.height > 900) invalid();
  const encoded = frame.pngBase64;
  if (typeof encoded !== 'string' || encoded.length > Math.ceil(4 * 1024 * 1024 / 3) * 4 || /[^A-Za-z0-9+/=]/.test(encoded)) invalid();
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length > 4 * 1024 * 1024 || bytes.toString('base64') !== encoded || !bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) invalid();
  let offset = 8, header = false, ended = false, dataEnded = false, depth = 0, channels = 0, color = 0, palette = false;
  const data: Buffer[] = [];
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) invalid();
    const size = bytes.readUInt32BE(offset), end = offset + 12 + size;
    if (end > bytes.length) invalid();
    const name = bytes.toString('ascii', offset + 4, offset + 8), payload = bytes.subarray(offset + 8, end - 4);
    if (crc(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) invalid();
    if (!header && name !== 'IHDR') invalid();
    if (name === 'IHDR') {
      if (header || size !== 13 || payload.readUInt32BE(0) !== frame.width || payload.readUInt32BE(4) !== frame.height) invalid();
      depth = payload[8]!;
      color = payload[9]!;
      const depths: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      if (!depths[color]?.includes(depth) || payload[10] !== 0 || payload[11] !== 0 || payload[12] !== 0) invalid();
      channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[color]!;
      header = true;
    } else if (name === 'PLTE') {
      if (palette || data.length || color === 0 || color === 4 || !size || size % 3 || size > 768 || (color === 3 && size / 3 > 2 ** depth)) invalid();
      palette = true;
    } else if (name === 'IDAT') {
      if (dataEnded || (color === 3 && !palette)) invalid();
      data.push(payload);
    } else {
      if (data.length) dataEnded = true;
      if (name === 'IEND') { if (size || !data.length || end !== bytes.length) invalid(); ended = true; }
      else if (name !== 'PLTE' && /^[A-Z]/.test(name)) invalid();
    }
    offset = end;
  }
  if (!ended) invalid();
  const stride = 1 + Math.ceil(frame.width * channels * depth / 8), expected = stride * frame.height;
  let pixels: Buffer;
  try { pixels = inflateSync(Buffer.concat(data), { maxOutputLength: expected }); } catch { invalid(); }
  if (pixels.length !== expected) invalid();
  for (let i = 0; i < pixels.length; i += stride) if (pixels[i]! > 4) invalid();
  return bytes;
}
