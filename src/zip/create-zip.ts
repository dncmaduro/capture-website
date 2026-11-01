const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

function writeUint16(target: Uint8Array, offset: number, value: number): void {
  target[offset] = value & 0xff;
  target[offset + 1] = (value >>> 8) & 0xff;
}

function writeUint32(target: Uint8Array, offset: number, value: number): void {
  target[offset] = value & 0xff;
  target[offset + 1] = (value >>> 8) & 0xff;
  target[offset + 2] = (value >>> 16) & 0xff;
  target[offset + 3] = (value >>> 24) & 0xff;
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;

  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      const mask = -(crc & 1);
      crc = (crc >>> 1) ^ (0xedb88320 & mask);
    }
  }

  return (crc ^ 0xffffffff) >>> 0;
}

function encodeFileName(name: string): Uint8Array {
  return new TextEncoder().encode(name);
}

/**
 * Creates a small, standards-compliant ZIP using the store method.
 * PNG is already compressed, so deflating it would add CPU and memory cost
 * without providing a useful size reduction.
 */
export function createZip(entries: ZipEntry[]): Uint8Array {
  if (entries.length > 0xffff) {
    throw new Error("A ZIP cannot contain more than 65,535 screenshots.");
  }

  const encodedEntries = entries.map((entry) => ({
    ...entry,
    nameBytes: encodeFileName(entry.name),
    checksum: crc32(entry.data),
  }));

  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let localOffset = 0;

  for (const entry of encodedEntries) {
    if (entry.nameBytes.length > 0xffff || entry.data.length > 0xffffffff) {
      throw new Error("A ZIP entry is too large.");
    }

    const localHeader = new Uint8Array(30 + entry.nameBytes.length);
    writeUint32(localHeader, 0, LOCAL_FILE_HEADER_SIGNATURE);
    writeUint16(localHeader, 4, 20);
    writeUint16(localHeader, 6, 0);
    writeUint16(localHeader, 8, 0);
    writeUint16(localHeader, 10, 0);
    writeUint16(localHeader, 12, 0);
    writeUint32(localHeader, 14, entry.checksum);
    writeUint32(localHeader, 18, entry.data.length);
    writeUint32(localHeader, 22, entry.data.length);
    writeUint16(localHeader, 26, entry.nameBytes.length);
    writeUint16(localHeader, 28, 0);
    localHeader.set(entry.nameBytes, 30);
    localParts.push(localHeader, entry.data);

    const centralHeader = new Uint8Array(46 + entry.nameBytes.length);
    writeUint32(centralHeader, 0, CENTRAL_DIRECTORY_SIGNATURE);
    writeUint16(centralHeader, 4, 20);
    writeUint16(centralHeader, 6, 20);
    writeUint16(centralHeader, 8, 0);
    writeUint16(centralHeader, 10, 0);
    writeUint16(centralHeader, 12, 0);
    writeUint16(centralHeader, 14, 0);
    writeUint32(centralHeader, 16, entry.checksum);
    writeUint32(centralHeader, 20, entry.data.length);
    writeUint32(centralHeader, 24, entry.data.length);
    writeUint16(centralHeader, 28, entry.nameBytes.length);
    writeUint16(centralHeader, 30, 0);
    writeUint16(centralHeader, 32, 0);
    writeUint16(centralHeader, 34, 0);
    writeUint16(centralHeader, 36, 0);
    writeUint32(centralHeader, 38, 0);
    writeUint32(centralHeader, 42, localOffset);
    centralHeader.set(entry.nameBytes, 46);
    centralParts.push(centralHeader);

    localOffset += localHeader.length + entry.data.length;
  }

  const centralDirectorySize = centralParts.reduce(
    (total, part) => total + part.length,
    0,
  );
  const endRecord = new Uint8Array(22);
  writeUint32(endRecord, 0, END_OF_CENTRAL_DIRECTORY_SIGNATURE);
  writeUint16(endRecord, 4, 0);
  writeUint16(endRecord, 6, 0);
  writeUint16(endRecord, 8, encodedEntries.length);
  writeUint16(endRecord, 10, encodedEntries.length);
  writeUint32(endRecord, 12, centralDirectorySize);
  writeUint32(endRecord, 16, localOffset);
  writeUint16(endRecord, 20, 0);

  const result = new Uint8Array(localOffset + centralDirectorySize + endRecord.length);
  let offset = 0;
  for (const part of localParts) {
    result.set(part, offset);
    offset += part.length;
  }
  for (const part of centralParts) {
    result.set(part, offset);
    offset += part.length;
  }
  result.set(endRecord, offset);

  return result;
}
