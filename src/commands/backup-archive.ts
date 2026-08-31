import { createReadStream } from "node:fs";
import { posix } from "node:path";
import { createGunzip } from "node:zlib";

export type TarMemberType = "file" | "dir" | "symlink" | "hardlink" | "other";

export interface TarMember {
  name: string;
  type: TarMemberType;
  linkname: string;
}

const REGULAR_REQUIRED = ["manifest.json", "phi.db"] as const;
const REGULAR_OPTIONAL = ["device-token", "git-remote"] as const;

export function normalizeMemberName(name: string): string {
  return name.replace(/^\.\//, "").replace(/\/$/, "");
}

export function unsafeArchivePath(entry: string): boolean {
  const trimmed = entry.trim();
  if (!trimmed || trimmed === "." || trimmed === "./") return false;
  const normalized = trimmed.replace(/^\.\//, "");
  if (normalized.startsWith("/")) return true;
  return normalized.split("/").some((part) => part === "..");
}

export function linkEscapesArchive(memberName: string, linkname: string): boolean {
  const target = linkname.trim();
  if (!target) return true;
  if (target.startsWith("/") || target.startsWith("~")) return true;
  const member = normalizeMemberName(memberName);
  const base = posix.dirname(member);
  const resolved = posix.normalize(base === "." ? target : posix.join(base, target));
  if (posix.isAbsolute(resolved)) return true;
  return resolved === ".." || resolved.startsWith("../");
}

export function hardlinkEscapesArchive(linkname: string): boolean {
  const target = linkname.trim();
  if (!target) return true;
  if (target.startsWith("/") || target.startsWith("~")) return true;
  const resolved = posix.normalize(target.replace(/^\.\//, ""));
  if (posix.isAbsolute(resolved)) return true;
  return resolved === ".." || resolved.startsWith("../");
}

export function assertSafeBackupMembers(members: readonly TarMember[]): void {
  for (const member of members) {
    if (unsafeArchivePath(member.name)) {
      throw new Error("backup archive contains unsafe paths");
    }
    if (member.type === "other") {
      const name = normalizeMemberName(member.name) || member.name;
      throw new Error(`backup archive contains an unsupported member: ${name}`);
    }
  }
  for (const required of REGULAR_REQUIRED) {
    const matches = members.filter(
      (member) => normalizeMemberName(member.name) === required,
    );
    if (matches.length === 0) {
      throw new Error(`not a phi backup (missing ${required})`);
    }
    if (matches.some((member) => member.type !== "file")) {
      throw new Error(`backup archive member ${required} must be a regular file`);
    }
  }
  for (const optional of REGULAR_OPTIONAL) {
    const matches = members.filter(
      (member) => normalizeMemberName(member.name) === optional,
    );
    if (matches.some((member) => member.type !== "file")) {
      throw new Error(`backup archive member ${optional} must be a regular file`);
    }
  }
  for (const member of members) {
    if (member.type === "symlink" && linkEscapesArchive(member.name, member.linkname)) {
      throw new Error("backup archive contains a link that escapes the archive");
    }
    if (member.type === "hardlink" && hardlinkEscapesArchive(member.linkname)) {
      throw new Error("backup archive contains a link that escapes the archive");
    }
  }
}

function cstring(block: Buffer, start: number, length: number): string {
  const slice = block.subarray(start, start + length);
  const zero = slice.indexOf(0);
  return slice.toString("utf8", 0, zero === -1 ? length : zero);
}

function octal(block: Buffer, start: number, length: number): number {
  const text = cstring(block, start, length).trim();
  if (!text) return 0;
  return Number.parseInt(text, 8);
}

function isZeroBlock(block: Buffer): boolean {
  return block.every((byte) => byte === 0);
}

function checksumOk(block: Buffer): boolean {
  const expected = octal(block, 148, 8);
  let sum = 0;
  for (let index = 0; index < 512; index += 1) {
    sum += index >= 148 && index < 156 ? 0x20 : block[index]!;
  }
  return sum === expected;
}

function headerName(block: Buffer): string {
  const name = cstring(block, 0, 100);
  const prefix = cstring(block, 345, 155);
  return prefix ? `${prefix}/${name}` : name;
}

function parsePax(data: Buffer): { path?: string; linkpath?: string } {
  const records: { path?: string; linkpath?: string } = {};
  const text = data.toString("utf8");
  let offset = 0;
  while (offset < text.length) {
    const space = text.indexOf(" ", offset);
    if (space === -1) break;
    const length = Number.parseInt(text.slice(offset, space), 10);
    if (!Number.isFinite(length) || length <= 0) break;
    const record = text.slice(offset, offset + length);
    const body = record.slice(space - offset + 1).replace(/\n$/, "");
    const eq = body.indexOf("=");
    if (eq !== -1) {
      const keyword = body.slice(0, eq);
      const value = body.slice(eq + 1);
      if (keyword === "path") records.path = value;
      if (keyword === "linkpath") records.linkpath = value;
    }
    offset += length;
  }
  return records;
}

const MAX_METADATA_SIZE = 1024 * 1024;

class ByteReader {
  private leftover = Buffer.alloc(0);
  private readonly chunks: AsyncIterator<Uint8Array>;

  constructor(source: AsyncIterable<Uint8Array>) {
    this.chunks = source[Symbol.asyncIterator]();
  }

  async read(size: number): Promise<Buffer | null> {
    if (size === 0) return Buffer.alloc(0);
    const parts: Buffer[] = [];
    let needed = size;
    while (needed > 0) {
      if (this.leftover.length === 0) {
        const next = await this.chunks.next();
        if (next.done) {
          if (parts.length === 0) return null;
          throw new Error("truncated tar archive");
        }
        this.leftover = Buffer.from(next.value);
      }
      const take = Math.min(needed, this.leftover.length);
      parts.push(this.leftover.subarray(0, take));
      this.leftover = this.leftover.subarray(take);
      needed -= take;
    }
    return parts.length === 1 ? Buffer.from(parts[0]!) : Buffer.concat(parts);
  }

  async skip(size: number): Promise<void> {
    let remaining = size;
    while (remaining > 0) {
      if (this.leftover.length > 0) {
        const take = Math.min(remaining, this.leftover.length);
        this.leftover = this.leftover.subarray(take);
        remaining -= take;
        continue;
      }
      const next = await this.chunks.next();
      if (next.done) throw new Error("truncated tar archive");
      const chunk = next.value;
      if (chunk.length <= remaining) {
        remaining -= chunk.length;
      } else {
        this.leftover = Buffer.from(chunk.subarray(remaining));
        remaining = 0;
      }
    }
  }
}

async function readMetadata(reader: ByteReader, size: number): Promise<Buffer> {
  if (size > MAX_METADATA_SIZE) {
    throw new Error("backup archive metadata is too large");
  }
  const padded = Math.ceil(size / 512) * 512;
  if (padded === 0) return Buffer.alloc(0);
  const data = await reader.read(padded);
  if (!data) throw new Error("truncated tar archive");
  return data.subarray(0, size);
}

async function skipPayload(reader: ByteReader, size: number): Promise<void> {
  const padded = Math.ceil(size / 512) * 512;
  if (padded === 0) return;
  await reader.skip(padded);
}

export async function listTarMembers(archive: string): Promise<TarMember[]> {
  const stream = createReadStream(archive).pipe(createGunzip());
  try {
    const reader = new ByteReader(stream);
    const members: TarMember[] = [];
    let pendingName: string | undefined;
    let pendingLink: string | undefined;
    let globalPax: { path?: string; linkpath?: string } = {};
    let nextPax: { path?: string; linkpath?: string } = {};

    for (;;) {
      const block = await reader.read(512);
      if (!block || isZeroBlock(block)) break;
      if (!checksumOk(block)) {
        throw new Error("backup archive is not a valid tar file");
      }
      const size = octal(block, 124, 12);
      const flag = block[156] ?? 0;
      const char = flag === 0 ? "0" : String.fromCharCode(flag);
      const name = headerName(block);
      const linkname = cstring(block, 157, 100);

      if (char === "L" || char === "K" || char === "x" || char === "g") {
        const payload = await readMetadata(reader, size);
        if (char === "L") pendingName = cstring(payload, 0, payload.length);
        else if (char === "K") pendingLink = cstring(payload, 0, payload.length);
        else {
          const records = parsePax(payload);
          if (char === "g") globalPax = { ...globalPax, ...records };
          else nextPax = records;
        }
        continue;
      }

      const type: TarMemberType =
        char === "0" || char === "7"
          ? "file"
          : char === "1"
            ? "hardlink"
            : char === "2"
              ? "symlink"
              : char === "5"
                ? "dir"
                : "other";
      members.push({
        name: nextPax.path ?? globalPax.path ?? pendingName ?? name,
        type,
        linkname: nextPax.linkpath ?? globalPax.linkpath ?? pendingLink ?? linkname,
      });
      pendingName = undefined;
      pendingLink = undefined;
      nextPax = {};
      await skipPayload(reader, size);
    }

    return members;
  } finally {
    stream.destroy();
  }
}
