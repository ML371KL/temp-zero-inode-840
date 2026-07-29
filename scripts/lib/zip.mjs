// Минимальный ZIP-экстрактор (без зависимостей): центральный каталог + inflateRaw.
// Достаточно для квартальных архивов SEC (deflate/store, без zip64).
import { inflateRawSync, deflateRawSync } from 'node:zlib';

const EOCD_SIG = 0x06054b50, CD_SIG = 0x02014b50, LFH_SIG = 0x04034b50;

export function zipEntries(buf) {
  // EOCD ищется с конца (комментарий архива до 64К)
  let eocd = -1;
  const start = Math.max(0, buf.length - 65558);
  for (let i = buf.length - 22; i >= start; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('zip: EOCD не найден');
  const count = buf.readUInt16LE(eocd + 10);
  const cdOff = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  let p = cdOff;
  for (let k = 0; k < count; k++) {
    if (buf.readUInt32LE(p) !== CD_SIG) throw new Error('zip: битый центральный каталог');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const elen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const lfhOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    entries.set(name, { method, csize, usize, lfhOff });
    p += 46 + nlen + elen + clen;
  }
  return entries;
}

export function zipExtract(buf, name) {
  const e = zipEntries(buf).get(name);
  if (!e) return null;
  if (buf.readUInt32LE(e.lfhOff) !== LFH_SIG) throw new Error('zip: битый локальный заголовок');
  const nlen = buf.readUInt16LE(e.lfhOff + 26);
  const elen = buf.readUInt16LE(e.lfhOff + 28);
  const dataOff = e.lfhOff + 30 + nlen + elen;
  const raw = buf.subarray(dataOff, dataOff + e.csize);
  if (e.method === 0) return Buffer.from(raw);
  if (e.method === 8) return inflateRawSync(raw);
  throw new Error(`zip: неподдерживаемый метод сжатия ${e.method}`);
}

// Сборка простейшего zip — используется только в самотестах (roundtrip).
export function zipCreate(files) {
  const chunks = [], cd = [];
  let off = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content);
    const comp = deflateRawSync(data);
    const nbuf = Buffer.from(name, 'utf8');
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(LFH_SIG, 0); lfh.writeUInt16LE(20, 4); lfh.writeUInt16LE(8, 8);
    lfh.writeUInt32LE(comp.length, 18); lfh.writeUInt32LE(data.length, 22);
    lfh.writeUInt16LE(nbuf.length, 26);
    chunks.push(lfh, nbuf, comp);
    const cde = Buffer.alloc(46);
    cde.writeUInt32LE(CD_SIG, 0); cde.writeUInt16LE(20, 6); cde.writeUInt16LE(8, 10);
    cde.writeUInt32LE(comp.length, 20); cde.writeUInt32LE(data.length, 24);
    cde.writeUInt16LE(nbuf.length, 28); cde.writeUInt32LE(off, 42);
    cd.push(Buffer.concat([cde, nbuf]));
    off += lfh.length + nbuf.length + comp.length;
  }
  const cdBuf = Buffer.concat(cd);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(cd.length, 8); eocd.writeUInt16LE(cd.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(off, 16);
  return Buffer.concat([...chunks, cdBuf, eocd]);
}
