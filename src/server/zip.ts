// A streaming ZIP writer for the receipt download. Entries are stored without
// compression (JPEG and PNG are compressed already), and each local header
// carries the size and CRC-32, so every unzip tool can read the file. One
// entry is in memory at a time; a receipt is at most 5 MiB. ZIP64 is not
// written: the archive stops with an error before it passes 4 GiB.

export type ZipEntry = { readonly name: string; readonly time: Date; readonly bytes: Uint8Array }

const ZIP32_MAX = 0xffffffff
const MAX_ENTRIES = 0xffff
/** General purpose flag bit 11: the file name is UTF-8. */
const UTF8 = 0x0800

/** MS-DOS time and date fields, in UTC. */
function dosTime(time: Date) {
  const year = Math.max(1980, time.getUTCFullYear())
  return {
    time: (time.getUTCHours() << 11) | (time.getUTCMinutes() << 5) | Math.floor(time.getUTCSeconds() / 2),
    date: ((year - 1980) << 9) | ((time.getUTCMonth() + 1) << 5) | time.getUTCDate(),
  }
}

type Written = { name: Uint8Array; crc: number; size: number; offset: number; time: number; date: number }

function localHeader(entry: Written): Uint8Array {
  const out = new Uint8Array(30 + entry.name.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, 0x04034b50, true)
  view.setUint16(4, 10, true) // version needed: 1.0, stored
  view.setUint16(6, UTF8, true)
  view.setUint16(8, 0, true) // method: stored
  view.setUint16(10, entry.time, true)
  view.setUint16(12, entry.date, true)
  view.setUint32(14, entry.crc, true)
  view.setUint32(18, entry.size, true)
  view.setUint32(22, entry.size, true)
  view.setUint16(26, entry.name.length, true)
  view.setUint16(28, 0, true)
  out.set(entry.name, 30)
  return out
}

function centralHeader(entry: Written): Uint8Array {
  const out = new Uint8Array(46 + entry.name.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, 0x02014b50, true)
  view.setUint16(4, 20, true) // made by: 2.0
  view.setUint16(6, 10, true)
  view.setUint16(8, UTF8, true)
  view.setUint16(10, 0, true)
  view.setUint16(12, entry.time, true)
  view.setUint16(14, entry.date, true)
  view.setUint32(16, entry.crc, true)
  view.setUint32(20, entry.size, true)
  view.setUint32(24, entry.size, true)
  view.setUint16(28, entry.name.length, true)
  // Extra field, comment, disk number, internal and external attributes: none.
  view.setUint32(42, entry.offset, true)
  out.set(entry.name, 46)
  return out
}

function endOfDirectory(data: { count: number; size: number; offset: number }): Uint8Array {
  const out = new Uint8Array(22)
  const view = new DataView(out.buffer)
  view.setUint32(0, 0x06054b50, true)
  view.setUint16(8, data.count, true)
  view.setUint16(10, data.count, true)
  view.setUint32(12, data.size, true)
  view.setUint32(16, data.offset, true)
  return out
}

/** The ZIP file of `entries`, written while they are read. A null entry is skipped. */
export function zipStream(entries: AsyncIterable<ZipEntry | null>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  const written: Written[] = []
  let offset = 0
  const iterator = entries[Symbol.asyncIterator]()
  let done = false
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (done) return
      // Each pull enqueues something, else the stream would wait for a read that never comes.
      let next = await iterator.next()
      while (!next.done && next.value === null) next = await iterator.next()
      if (!next.done && next.value) {
        const entry = next.value
        const name = encoder.encode(entry.name)
        if (written.length >= MAX_ENTRIES || offset + 30 + name.length + entry.bytes.length > ZIP32_MAX)
          throw new Error('The receipt download would exceed the ZIP format limits')
        const record: Written = { name, crc: Bun.hash.crc32(entry.bytes) >>> 0, size: entry.bytes.length, offset, ...dosTime(entry.time) }
        const header = localHeader(record)
        controller.enqueue(header)
        controller.enqueue(entry.bytes)
        offset += header.length + entry.bytes.length
        written.push(record)
        return
      }
      done = true
      const start = offset
      for (const record of written) {
        const header = centralHeader(record)
        controller.enqueue(header)
        offset += header.length
      }
      if (offset > ZIP32_MAX) throw new Error('The receipt download would exceed the ZIP format limits')
      controller.enqueue(endOfDirectory({ count: written.length, size: offset - start, offset: start }))
      controller.close()
    },
    async cancel() {
      await iterator.return?.()
    },
  })
}
