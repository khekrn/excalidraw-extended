/**
 * Minimal ZIP reader — enough for .docx (Office Open XML) packages.
 * Reads the central directory and inflates entries on demand.
 */
import { inflateRaw } from "pako";

export type ZipArchive = {
  names: string[];
  has: (name: string) => boolean;
  read: (name: string) => Uint8Array | null;
  readText: (name: string) => string | null;
};

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

export const readZip = (bytes: Uint8Array): ZipArchive => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // the end-of-central-directory record sits within the last 64KB + 22 bytes
  let eocd = -1;
  for (
    let i = bytes.length - 22;
    i >= Math.max(0, bytes.length - 22 - 0xffff);
    i--
  ) {
    if (view.getUint32(i, true) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    throw new Error("Not a valid .docx file (it isn't a ZIP package)");
  }

  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder();
  const entries = new Map<
    string,
    { method: number; compressedSize: number; localOffset: number }
  >();

  for (let i = 0; i < count; i++) {
    if (
      offset + 46 > bytes.length ||
      view.getUint32(offset, true) !== CENTRAL_SIGNATURE
    ) {
      throw new Error("Not a valid .docx file (damaged ZIP directory)");
    }
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = decoder.decode(
      bytes.subarray(offset + 46, offset + 46 + nameLength),
    );
    entries.set(name, { method, compressedSize, localOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }

  const read = (name: string): Uint8Array | null => {
    const entry = entries.get(name);
    if (!entry) {
      return null;
    }
    const { localOffset, compressedSize, method } = entry;
    if (view.getUint32(localOffset, true) !== LOCAL_SIGNATURE) {
      throw new Error(`Damaged ZIP entry: ${name}`);
    }
    const nameLength = view.getUint16(localOffset + 26, true);
    const extraLength = view.getUint16(localOffset + 28, true);
    const start = localOffset + 30 + nameLength + extraLength;
    const data = bytes.subarray(start, start + compressedSize);
    if (method === 0) {
      return data;
    }
    if (method === 8) {
      return inflateRaw(data);
    }
    throw new Error(`Unsupported ZIP compression (${method}) for ${name}`);
  };

  return {
    names: [...entries.keys()],
    has: (name) => entries.has(name),
    read,
    readText: (name) => {
      const data = read(name);
      return data ? decoder.decode(data) : null;
    },
  };
};
