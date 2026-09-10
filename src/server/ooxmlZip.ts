/**
 * ooxmlZip — empacotador ZIP (STORED, sem compressão) + CRC32 + escape XML,
 * compartilhado pelos geradores OOXML sem dependência externa (XLSX Fase 2.3 e
 * DOCX F5.2). O repo decidiu não depender de lib de zip/office (frágil via
 * transitiva); este helper é o mínimo VÁLIDO e DETERMINÍSTICO (data DOS fixa →
 * mesmo input, mesmo byte) que Excel/Word/LibreOffice abrem. Extraído do
 * XlsxService pra que XLSX e DOCX partilhem o MESMO empacotador (sem duplicar).
 */

// CRC32 (tabela IEEE) — próprio, pra não depender de zlib.crc32 nem de lib.
const CRC_TABLE: number[] = (() => {
  const t: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const DOS_TIME = 0; // 00:00:00
const DOS_DATE = ((2020 - 1980) << 9) | (1 << 5) | 1; // 2020-01-01 (fixo → determinístico)

export function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export interface ZipEntry { name: string; data: Buffer; }

/** Empacota entradas num container ZIP STORED (determinístico). */
export function zipStored(files: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, "utf-8");
    const crc = crc32(f.data);
    const size = f.data.length;

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);      // version needed
    local.writeUInt16LE(0, 6);       // flags
    local.writeUInt16LE(0, 8);       // method: stored
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18);   // compressed = uncompressed (stored)
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);      // extra len
    nameBuf.copy(local, 30);
    locals.push(local, f.data);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);    // version made by
    central.writeUInt16LE(20, 6);    // version needed
    central.writeUInt16LE(0, 8);     // flags
    central.writeUInt16LE(0, 10);    // method
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(size, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);    // extra len
    central.writeUInt16LE(0, 32);    // comment len
    central.writeUInt16LE(0, 34);    // disk start
    central.writeUInt16LE(0, 36);    // internal attrs
    central.writeUInt32LE(0, 38);    // external attrs
    central.writeUInt32LE(offset, 42); // local header offset
    nameBuf.copy(central, 46);
    centrals.push(central);

    offset += local.length + f.data.length;
  }

  const centralDir = Buffer.concat(centrals);
  const localAll = Buffer.concat(locals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);          // disk
  eocd.writeUInt16LE(0, 6);          // cd start disk
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(localAll.length, 16); // cd offset = after all locals
  eocd.writeUInt16LE(0, 20);         // comment len

  return Buffer.concat([localAll, centralDir, eocd]);
}
