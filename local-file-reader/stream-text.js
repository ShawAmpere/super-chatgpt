import { open } from 'node:fs/promises';

// A cursor is saved only at a physical line boundary. CR/LF are single-byte
// ASCII in UTF-8/GB18030, and aligned code units in UTF-16. Decoder state is
// therefore complete at every saved position, including surrogate pairs.
export async function* streamTextLines(file, encoding, start = 0) {
  const width = encoding.startsWith('utf-16') ? 2 : 1;
  if (!Number.isSafeInteger(start) || start < 0 || start % width) throw new Error('Invalid text search byte cursor.');
  const handle = await open(file, 'r');
  let parts = [], length = 0, base = start, position = start, pendingCR = false;
  const append = part => { if (part.length) { parts.push(part); length += part.length; } };
  const line = next => {
    const bytes = parts.length === 1 ? parts[0] : Buffer.concat(parts, length);
    const row = { text: new TextDecoder(encoding, { fatal: true, ignoreBOM: base !== 0 }).decode(bytes), offset: base, nextOffset: next };
    parts = []; length = 0; base = next;
    return row;
  };
  try {
    while (true) {
      const chunk = Buffer.allocUnsafe(65536);
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      const chunkStart = position; position += bytesRead;
      const unit = offset => width === 1 ? chunk[offset] : encoding === 'utf-16be' ? chunk.readUInt16BE(offset) : chunk.readUInt16LE(offset);
      let cut = 0;
      if (pendingCR) {
        if (bytesRead >= width && unit(0) === 10) cut = width;
        yield line(chunkStart + cut); pendingCR = false;
      }
      if (!bytesRead) { yield line(position); break; }
      for (let scan = cut; scan + width <= bytesRead; scan += width) {
        const code = unit(scan);
        if (code !== 10 && code !== 13) continue;
        append(chunk.subarray(cut, scan));
        let next = scan + width;
        if (code === 13 && next === bytesRead) { pendingCR = true; cut = next; break; }
        if (code === 13 && next + width <= bytesRead && unit(next) === 10) next += width;
        yield line(chunkStart + next); cut = next; scan = next - width;
      }
      append(chunk.subarray(cut, bytesRead));
    }
  } finally { await handle.close(); }
}
