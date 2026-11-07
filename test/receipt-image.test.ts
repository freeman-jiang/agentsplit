// The upload check reads the image header itself (the current app used sharp).
import { expect, it } from 'vitest'
import { imageInfo, receiptKey } from '~/server/receipts'
import { JPEG as jpeg, png as pngOf } from './kit/images'

const png = (width: number, height: number) => pngOf({ width, height })

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
  // Production stores three documents under this older key form; they must keep loading.
  expect(receiptKey('https://agentsplit-receipts.freemanjiang.com/agentsplit-receipts/document-2026-10-01T22:51:14.443Z-oGoSSKO-SUxcez0iFwaHc.png')).toBe(
    'document-2026-10-01T22:51:14.443Z-oGoSSKO-SUxcez0iFwaHc.png',
  )
  for (const bad of ['https://x/b/receipts/../a.jpg', 'https://x/b/receipts/a.jpg?x', 'https://x/b/receipts/a%2e.jpg', 'https://x/b/receipts/a.jpg#', 'https://x/', 'r2://agentsplit-receipts/', 'r2://agentsplit-receipts/receipts/a\0.png'])
    expect(receiptKey(bad)).toBeNull()
})
