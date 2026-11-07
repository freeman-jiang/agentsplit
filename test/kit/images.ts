// The smallest images the upload check accepts: it reads only the header (src/server/receipts.ts).

/** A PNG header of `width` × `height`, padded with zeros to `bytes`. */
export function png(data: { width: number; height: number; bytes?: number }): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(data.bytes ?? 33)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
  const view = new DataView(bytes.buffer)
  view.setUint32(16, data.width)
  view.setUint32(20, data.height)
  return bytes
}

/** SOI, an APP0 segment, then a baseline frame header with height 480 and width 640. */
export const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xe0, 0x02, 0x80, 0x03, 0x01, 0x22, 0x00])
