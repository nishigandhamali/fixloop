import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Content-addressed blob storage. Keys are SHA-256 hex only, so callers can never supply a path. */
export interface BlobStorage {
  put(sha256: string, bytes: Buffer): Promise<string>;
  get(sha256: string): Promise<Buffer>;
}

const KEY = /^[a-f0-9]{64}$/;
export class LocalFsStorage implements BlobStorage {
  constructor(private readonly root: string) {}
  private pathFor(key: string) {
    if (!KEY.test(key)) throw new Error("invalid storage key");
    return join(this.root, key.slice(0, 2), key);
  }
  async put(key: string, bytes: Buffer) {
    const path = this.pathFor(key);
    await mkdir(join(this.root, key.slice(0, 2)), { recursive: true });
    await writeFile(path, bytes, { flag: "w" });
    return `${key.slice(0, 2)}/${key}`;
  }
  get(key: string) {
    return readFile(this.pathFor(key));
  }
}
