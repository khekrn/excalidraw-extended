import { vi } from "vitest";

import type { FileId } from "@excalidraw/element/types";

import { saveFilesToFirebase } from "../data/firebase";

describe("saveFilesToFirebase (collab worker storage)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uploads share-link files to the worker with the link's token", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response("{}", { status: 201 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await saveFilesToFirebase({
      prefix: "/files/shareLinks/abcdefghij12",
      files: [{ id: "file" as FileId, buffer: new Uint8Array([1]) }],
      token: "secret",
    });

    expect(result).toEqual({ savedFiles: ["file"], erroredFiles: [] });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://localhost:8787/shares/abcdefghij12/files/file");
    expect(init?.method).toBe("PUT");
    expect((init?.headers as Record<string, string>)["x-share-token"]).toBe(
      "secret",
    );
  });

  it("maps room prefixes (with or without a leading slash)", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response("{}", { status: 201 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await saveFilesToFirebase({
      prefix: "files/rooms/0123456789abcdef0123",
      files: [{ id: "img" as FileId, buffer: new Uint8Array([1]) }],
    });

    expect(fetchMock.mock.calls[0][0]).toBe(
      "http://localhost:8787/rooms/0123456789abcdef0123/files/img",
    );
  });

  it("reports failed uploads per file", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );

    const result = await saveFilesToFirebase({
      prefix: "/files/rooms/0123456789abcdef0123",
      files: [{ id: "file" as FileId, buffer: new Uint8Array([1]) }],
    });

    expect(result).toEqual({ savedFiles: [], erroredFiles: ["file"] });
  });

  it("rejects the whole save for an unknown storage prefix", async () => {
    await expect(
      saveFilesToFirebase({
        prefix: "/somewhere/else",
        files: [{ id: "file" as FileId, buffer: new Uint8Array([1]) }],
      }),
    ).rejects.toThrow();
  });
});
