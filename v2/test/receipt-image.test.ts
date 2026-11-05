// The upload check reads the image header itself (the current app used sharp).
import { expect, it } from 'vitest'
import { imageInfo, receiptKey } from '~/server/receipts'

const png = (width: number, height: number) => {
  const bytes = new Uint8Array(33)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
  new DataView(bytes.buffer).setUint32(16, width)
  new DataView(bytes.buffer).setUint32(20, height)
  return bytes
}
// SOI, an APP0 segment, then a baseline frame header with height 480 and width 640.
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xe0, 0x02, 0x80, 0x03, 0x01, 0x22, 0x00])

it('reads JPEG and PNG sizes from the content, and refuses anything else', () => {
  expect(imageInfo(png(640, 480))).toEqual({ format: 'png', width: 640, height: 480 })
  expect(imageInfo(jpeg)).toEqual({ format: 'jpeg', width: 640, height: 480 })
  expect(imageInfo(png(0, 10))).toBeNull()
  // Over 40 megapixels.
  expect(imageInfo(png(8000, 5001))).toBeNull()
  expect(imageInfo(png(8000, 5000))).not.toBeNull()
  expect(imageInfo(new TextEncoder().encode('GIF89a not a receipt'))).toBeNull()
  expect(imageInfo(jpeg.slice(0, 10))).toBeNull()
})

it('derives the storage key and refuses unsafe pointers', () => {
  expect(receiptKey('https://garage.example/agentsplit/receipts/AbC_-123456789012345678.jpg')).toBe('receipts/AbC_-123456789012345678.jpg')
  expect(receiptKey('r2://agentsplit-receipts/receipts/x.png')).toBe('receipts/x.png')
  for (const bad of ['https://x/receipts/../a.jpg', 'https://x/receipts/a.jpg?x', 'https://x/receipts/a%2e.jpg', 'https://x/receipts/a.jpg#', 'https://x/other/a.gif'])
    expect(receiptKey(bad)).toBeNull()
})
