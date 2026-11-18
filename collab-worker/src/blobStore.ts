/**
 * Binary values in a Durable Object's SQLite storage, chunked so values can
 * exceed the 2MB row limit.
 */

// well under the 2MB per-row limit
const CHUNK_BYTES = 1536 * 1024;

export type BlobMeta = Record<string, string | number | boolean | null>;

export class BlobStore {
  constructor(private storage: DurableObjectStorage) {
    storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS blobs (
        key TEXT PRIMARY KEY,
        size INTEGER NOT NULL,
        chunks INTEGER NOT NULL,
        meta TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
    );
    storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS chunks (
        key TEXT NOT NULL,
        idx INTEGER NOT NULL,
        data BLOB NOT NULL,
        PRIMARY KEY (key, idx)
      )`,
    );
  }

  head(
    key: string,
  ): { size: number; meta: BlobMeta; updatedAt: number } | null {
    const row = this.storage.sql
      .exec<{ size: number; meta: string; updated_at: number }>(
        "SELECT size, meta, updated_at FROM blobs WHERE key = ?",
        key,
      )
      .toArray()[0];
    return row
      ? {
          size: row.size,
          meta: JSON.parse(row.meta),
          updatedAt: row.updated_at,
        }
      : null;
  }

  has(key: string) {
    return !!this.head(key);
  }

  put(key: string, data: ArrayBuffer, meta: BlobMeta = {}) {
    const bytes = new Uint8Array(data);
    const chunks = Math.max(1, Math.ceil(bytes.byteLength / CHUNK_BYTES));
    this.storage.transactionSync(() => {
      this.storage.sql.exec("DELETE FROM chunks WHERE key = ?", key);
      for (let idx = 0; idx < chunks; idx++) {
        const part = bytes.slice(idx * CHUNK_BYTES, (idx + 1) * CHUNK_BYTES);
        this.storage.sql.exec(
          "INSERT INTO chunks (key, idx, data) VALUES (?, ?, ?)",
          key,
          idx,
          part.buffer,
        );
      }
      this.storage.sql.exec(
        `INSERT INTO blobs (key, size, chunks, meta, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           size = excluded.size,
           chunks = excluded.chunks,
           meta = excluded.meta,
           updated_at = excluded.updated_at`,
        key,
        bytes.byteLength,
        chunks,
        JSON.stringify(meta),
        Date.now(),
      );
    });
  }

  get(key: string): { data: Uint8Array; meta: BlobMeta } | null {
    const head = this.head(key);
    if (!head) {
      return null;
    }
    const out = new Uint8Array(head.size);
    let offset = 0;
    for (const row of this.storage.sql.exec<{ data: ArrayBuffer }>(
      "SELECT data FROM chunks WHERE key = ? ORDER BY idx",
      key,
    )) {
      const part = new Uint8Array(row.data);
      out.set(part, offset);
      offset += part.byteLength;
    }
    if (offset !== head.size) {
      throw new Error(`Corrupted blob "${key}"`);
    }
    return { data: out, meta: head.meta };
  }
}
