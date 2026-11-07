// Receipt files in the browser: photos shrink before upload, and a receipt
// deleted for good shows who deleted it and when.
import { formatMoment } from '~/client/dates'

/** The long side of an uploaded photo, in pixels. Receipt text stays readable at this size. */
const LONG_SIDE = 2000
const JPEG_QUALITY = 0.85
/** A file this small with a long side of at most LONG_SIDE uploads unchanged: most screenshots, whose text a JPEG would blur. */
const KEEP_BYTES = 1024 * 1024

/**
 * The file to upload: a JPEG of at most 2000 px on the long side, quality 0.85,
 * with the camera's orientation applied. A small image uploads unchanged, and
 * so does a file the browser cannot decode (the server checks every upload).
 */
export async function prepareReceipt(file: File): Promise<File> {
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
  } catch {
    return file
  }
  try {
    const long = Math.max(bitmap.width, bitmap.height)
    if (long <= LONG_SIDE && file.size <= KEEP_BYTES) return file
    const scale = Math.min(1, LONG_SIDE / long)
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(bitmap.width * scale))
    canvas.height = Math.max(1, Math.round(bitmap.height * scale))
    const context = canvas.getContext('2d')
    if (!context) return file
    // A JPEG has no transparency: a transparent PNG gets a white page, as on paper.
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY))
    // Keep an image that was small enough already when the JPEG is not smaller.
    if (!blob || (long <= LONG_SIDE && blob.size >= file.size)) return file
    return new File([blob], `${file.name.replace(/\.[^.]*$/, '') || 'receipt'}.jpg`, { type: 'image/jpeg', lastModified: file.lastModified })
  } finally {
    bitmap.close()
  }
}

export type Tombstone = { readonly by: string; readonly at: string }

/** "Receipt deleted by Alice on Nov 7, 2026". */
export const tombstoneText = (tombstone: Tombstone) =>
  `Receipt deleted by ${tombstone.by} on ${formatMoment.date(tombstone.at)}`
