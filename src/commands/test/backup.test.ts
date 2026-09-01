import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import type { CliOutput } from "@/cli";
import {
  backupFileName,
  RESTORE_IN_USE,
  runBackup,
  runRestore,
  unsafeArchivePath,
} from "@/commands/backup";
import { linkEscapesArchive, hardlinkEscapesArchive, assertSafeBackupMembers, listTarMembers } from "@/commands/backup-archive";
import { PhiStore } from "@/core/store/store";
import { tempDir } from "@/testing/tmpdir";

const dirs: string[] = [];
const stores: PhiStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) {
    try {
      store.close();
    } catch {
      // Already closed.
    }
  }
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function capture() {
  let stdout = "";
  let stderr = "";
  const output: CliOutput = {
    stdout: (message) => {
      stdout += message;
    },
    stderr: (message) => {
      stderr += message;
    },
  };
  return { output, stdout: () => stdout, stderr: () => stderr };
}

function scratch(prefix: string): string {
  const dir = tempDir(prefix);
  dirs.push(dir);
  return dir;
}

function token(): string {
  return `phi_dt_${"ab".repeat(32)}`;
}

function seedRoot(label = "keep"): { root: string; threadId: string } {
  const root = scratch("phi-backup-root-");
  const store = new PhiStore(root);
  stores.push(store);
  const channel = store.listChannels(store.defaultWorkspace().id)[0]!;
  const { thread } = store.createThread(channel.id, {
    author: "user",
    kind: "message",
    content: label,
  });
  store.close();
  stores.pop();

  mkdirSync(join(root, "uploads"), { recursive: true });
  writeFileSync(join(root, "uploads", "blob.bin"), "blob");
  writeFileSync(join(root, "device-token"), `${token()}\n`, { mode: 0o600 });
  writeFileSync(join(root, "git-remote"), "https://example.com/phi.git\n");
  mkdirSync(join(root, "models"), { recursive: true });
  writeFileSync(join(root, "models", "keep.bin"), "model-bytes");
  mkdirSync(join(root, "workspace", "channels", "general"), { recursive: true });
  writeFileSync(join(root, "workspace", "channels", "general", "note.md"), "note");
  return { root, threadId: thread.id };
}

async function tarList(archive: string): Promise<string> {
  const child = Bun.spawn(["tar", "-tzf", archive], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    child.exited,
  ]);
  expect(exitCode).toBe(0);
  return stdout;
}

function tarHeader(name: string, size: number): Buffer {
  const block = Buffer.alloc(512);
  block.write(name, 0, Math.min(name.length, 99), "utf8");
  block.write("0000644\0", 100, 8, "utf8");
  block.write("0000000\0", 108, 8, "utf8");
  block.write("0000000\0", 116, 8, "utf8");
  block.write(`${size.toString(8).padStart(11, "0")}\0`, 124, 12, "utf8");
  block.write(`${Math.floor(Date.now() / 1000).toString(8).padStart(11, "0")}\0`, 136, 12, "utf8");
  block.write("        ", 148, 8, "utf8");
  block[156] = "0".charCodeAt(0);
  block.write("ustar\0", 257, 6, "utf8");
  block.write("00", 263, 2, "utf8");
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "utf8");
  return block;
}

function writeGzipTar(
  archive: string,
  files: Array<{ name: string; content: string }>,
): void {
  const parts: Buffer[] = [];
  for (const file of files) {
    const body = Buffer.from(file.content);
    const padded = Buffer.alloc(Math.ceil(body.length / 512) * 512);
    body.copy(padded);
    parts.push(tarHeader(file.name, body.length), padded);
  }
  parts.push(Buffer.alloc(1024));
  writeFileSync(archive, gzipSync(Buffer.concat(parts)));
}

describe("backup and restore", () => {
  test("prints backup help", async () => {
    const out = capture();
    expect(await runBackup(out.output, ["--help"])).toBe(0);
    expect(out.stdout()).toContain("Usage: phi backup [FILE]");
    expect(out.stdout()).toContain("secrets");
  });

  test("prints restore help", async () => {
    const out = capture();
    expect(await runRestore(out.output, ["-h"])).toBe(0);
    expect(out.stdout()).toContain("Usage: phi restore FILE --confirm");
    expect(out.stdout()).toContain("database is open");
  });

  test("refuses backup when the database is missing", async () => {
    const root = scratch("phi-backup-empty-");
    await expect(
      runBackup(capture().output, [], { env: { PHI_ROOT: root }, cwd: root }),
    ).rejects.toThrow(`no phi database at ${join(root, "phi.db")}`);
  });

  test("writes a default timestamped archive name", async () => {
    const { root } = seedRoot();
    const cwd = scratch("phi-backup-cwd-");
    const now = new Date(2026, 7, 31, 12, 51, 7);
    const out = capture();
    expect(
      await runBackup(out.output, [], { env: { PHI_ROOT: root }, cwd, now }),
    ).toBe(0);
    const dest = join(cwd, backupFileName(now));
    expect(out.stdout()).toBe(`Wrote ${dest}\n`);
    expect(await tarList(dest)).toContain("phi.db");
  });

  test("refuses to overwrite an existing archive", async () => {
    const { root } = seedRoot();
    const cwd = scratch("phi-backup-cwd-");
    const dest = join(cwd, "already.tar.gz");
    writeFileSync(dest, "nope");
    await expect(
      runBackup(capture().output, ["already.tar.gz"], {
        env: { PHI_ROOT: root },
        cwd,
      }),
    ).rejects.toThrow(`backup file already exists: ${dest}`);
    expect(readFileSync(dest, "utf8")).toBe("nope");
  });

  test("archives product files and skips the model cache", async () => {
    const { root } = seedRoot();
    const dest = join(scratch("phi-backup-cwd-"), "phi.tar.gz");
    expect(
      await runBackup(capture().output, [dest], { env: { PHI_ROOT: root } }),
    ).toBe(0);
    const listing = await tarList(dest);
    expect(listing).toContain("phi.db");
    expect(listing).toContain("manifest.json");
    expect(listing).toContain("workspace/");
    expect(listing).toContain("uploads/");
    expect(listing).toContain("device-token");
    expect(listing).toContain("git-remote");
    expect(listing).not.toContain("models");
    expect(statSync(dest).mode & 0o777).toBe(0o600);
  });

  test("live backup keeps committed rows and not later writes", async () => {
    const root = scratch("phi-backup-live-");
    const store = new PhiStore(root);
    stores.push(store);
    const channel = store.listChannels(store.defaultWorkspace().id)[0]!;
    const first = store.createThread(channel.id, {
      author: "user",
      kind: "message",
      content: "alpha",
    });
    const dest = join(scratch("phi-backup-cwd-"), "live.tar.gz");
    expect(
      await runBackup(capture().output, [dest], {
        env: { PHI_ROOT: root },
        afterDatabaseSnapshot: () => {
          store.createThread(channel.id, {
            author: "user",
            kind: "message",
            content: "beta",
          });
        },
      }),
    ).toBe(0);
    store.close();
    stores.pop();

    const target = scratch("phi-restore-target-");
    expect(
      await runRestore(capture().output, [dest, "--confirm"], {
        env: { PHI_ROOT: target },
      }),
    ).toBe(0);
    const restored = new PhiStore(target);
    stores.push(restored);
    const channelRestored = restored.listChannels(restored.defaultWorkspace().id)[0]!;
    const contents = restored
      .listThreads(channelRestored.id)
      .flatMap((thread) =>
        restored.listMessages(thread.id).map((message) => message.content),
      );
    expect(contents).toContain("alpha");
    expect(contents).not.toContain("beta");
    expect(restored.listMessages(first.thread.id).map((m) => m.content)).toEqual([
      "alpha",
    ]);
    restored.close();
    stores.pop();
  });

  test("restore round-trips files and leaves models alone", async () => {
    const { root, threadId } = seedRoot("original");
    const dest = join(scratch("phi-backup-cwd-"), "roundtrip.tar.gz");
    expect(
      await runBackup(capture().output, [dest], { env: { PHI_ROOT: root } }),
    ).toBe(0);

    writeFileSync(join(root, "workspace", "channels", "general", "note.md"), "changed");
    writeFileSync(join(root, "uploads", "blob.bin"), "changed");
    writeFileSync(join(root, "git-remote"), "https://example.com/other.git\n");
    writeFileSync(join(root, "models", "keep.bin"), "new-model");
    const store = new PhiStore(root);
    stores.push(store);
    const channel = store.listChannels(store.defaultWorkspace().id)[0]!;
    store.createThread(channel.id, {
      author: "user",
      kind: "message",
      content: "after-backup",
    });
    store.close();
    stores.pop();

    const out = capture();
    expect(
      await runRestore(out.output, ["--confirm", dest], {
        env: { PHI_ROOT: root },
      }),
    ).toBe(0);
    expect(out.stdout()).toBe(`Restored ${root} from ${dest}\n`);
    expect(readFileSync(join(root, "workspace", "channels", "general", "note.md"), "utf8")).toBe(
      "note",
    );
    expect(readFileSync(join(root, "uploads", "blob.bin"), "utf8")).toBe("blob");
    expect(readFileSync(join(root, "git-remote"), "utf8")).toBe(
      "https://example.com/phi.git\n",
    );
    expect(readFileSync(join(root, "device-token"), "utf8").trim()).toBe(token());
    expect(readFileSync(join(root, "models", "keep.bin"), "utf8")).toBe("new-model");

    const restored = new PhiStore(root);
    stores.push(restored);
    expect(restored.listMessages(threadId).map((m) => m.content)).toEqual([
      "original",
    ]);
    restored.close();
    stores.pop();
  });

  test("restore without --confirm does not touch the root", async () => {
    const { root } = seedRoot();
    const dest = join(scratch("phi-backup-cwd-"), "noconfirm.tar.gz");
    await runBackup(capture().output, [dest], { env: { PHI_ROOT: root } });
    writeFileSync(join(root, "workspace", "channels", "general", "note.md"), "changed");
    await expect(
      runRestore(capture().output, [dest], { env: { PHI_ROOT: root } }),
    ).rejects.toThrow(`pass --confirm to restore into ${root}`);
    expect(
      readFileSync(join(root, "workspace", "channels", "general", "note.md"), "utf8"),
    ).toBe("changed");
  });

  test("restore refuses while the database is open", async () => {
    const { root } = seedRoot();
    const dest = join(scratch("phi-backup-cwd-"), "inuse.tar.gz");
    await runBackup(capture().output, [dest], { env: { PHI_ROOT: root } });
    const holder = new PhiStore(root);
    stores.push(holder);
    await expect(
      runRestore(capture().output, [dest, "--confirm"], {
        env: { PHI_ROOT: root },
      }),
    ).rejects.toThrow(RESTORE_IN_USE);
    expect(RESTORE_IN_USE).toContain("phi service stop");
    holder.close();
    stores.pop();
  });

  test("restore refuses a leftover outgoing directory", async () => {
    const { root } = seedRoot();
    const dest = join(scratch("phi-backup-cwd-"), "leftover.tar.gz");
    await runBackup(capture().output, [dest], { env: { PHI_ROOT: root } });
    const outgoing = join(root, ".phi-restore-outgoing");
    mkdirSync(outgoing);
    writeFileSync(join(outgoing, "phi.db"), "old");
    await expect(
      runRestore(capture().output, [dest, "--confirm"], {
        env: { PHI_ROOT: root },
      }),
    ).rejects.toThrow("incomplete restore");
    expect(readFileSync(join(outgoing, "phi.db"), "utf8")).toBe("old");
  });

  test("restore refuses a device-token symlink and does not chmod its target", async () => {
    const outsideDir = scratch("phi-outside-");
    const victim = join(outsideDir, "victim");
    writeFileSync(victim, "secret\n", { mode: 0o644 });
    const stage = scratch("phi-evil-stage-");
    writeFileSync(
      join(stage, "manifest.json"),
      '{"format":1,"phiVersion":"0","createdAt":"x"}\n',
    );
    writeFileSync(join(stage, "phi.db"), "not-sql");
    symlinkSync(victim, join(stage, "device-token"));
    const archive = join(scratch("phi-evil-out-"), "evil.tar.gz");
    const child = Bun.spawn(["tar", "-czf", archive, "-C", stage, "."], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await child.exited).toBe(0);

    const target = scratch("phi-evil-target-");
    await expect(
      runRestore(capture().output, [archive, "--confirm"], {
        env: { PHI_ROOT: target },
      }),
    ).rejects.toThrow("device-token must be a regular file");
    expect(statSync(victim).mode & 0o777).toBe(0o644);
    expect(readFileSync(victim, "utf8")).toBe("secret\n");
    expect(existsSync(join(target, "device-token"))).toBe(false);
  });

  test("restore rolls back installed members before restoring the old root", async () => {
    const { root, threadId } = seedRoot("original");
    const dest = join(scratch("phi-backup-cwd-"), "rollback.tar.gz");
    await runBackup(capture().output, [dest], { env: { PHI_ROOT: root } });
    writeFileSync(join(root, "workspace", "channels", "general", "note.md"), "changed");
    writeFileSync(join(root, "uploads", "blob.bin"), "changed");

    await expect(
      runRestore(capture().output, [dest, "--confirm"], {
        env: { PHI_ROOT: root },
        afterInstallMember: (name) => {
          if (name === "uploads") throw new Error("injected install failure");
        },
      }),
    ).rejects.toThrow("injected install failure");

    expect(readFileSync(join(root, "workspace", "channels", "general", "note.md"), "utf8")).toBe(
      "changed",
    );
    expect(readFileSync(join(root, "uploads", "blob.bin"), "utf8")).toBe("changed");
    expect(existsSync(join(root, ".phi-restore-outgoing"))).toBe(false);
    const restored = new PhiStore(root);
    stores.push(restored);
    expect(restored.listMessages(threadId).map((m) => m.content)).toEqual(["original"]);
    restored.close();
    stores.pop();
  });

  test("restore refuses archives with parent paths", async () => {
    const archive = join(scratch("phi-evil-out-"), "evil.tar.gz");
    writeGzipTar(archive, [
      { name: "../pwned", content: "pwn" },
      { name: "manifest.json", content: '{"format":1,"phiVersion":"0","createdAt":"x"}\n' },
      { name: "phi.db", content: "not-sql" },
    ]);
    expect((await listTarMembers(archive)).map((member) => member.name)).toContain(
      "../pwned",
    );

    const target = scratch("phi-evil-target-");
    await expect(
      runRestore(capture().output, [archive, "--confirm"], {
        env: { PHI_ROOT: target },
      }),
    ).rejects.toThrow("unsafe paths");
  });
});

describe("unsafeArchivePath", () => {
  test("allows ordinary members and rejects traversal", () => {
    expect(unsafeArchivePath("./manifest.json")).toBe(false);
    expect(unsafeArchivePath("workspace/")).toBe(false);
    expect(unsafeArchivePath("workspace/channels/general/note.md")).toBe(false);
    expect(unsafeArchivePath("../pwned")).toBe(true);
    expect(unsafeArchivePath("/etc/passwd")).toBe(true);
    expect(unsafeArchivePath("workspace/../../etc/passwd")).toBe(true);
  });

  test("linkEscapesArchive allows in-tree targets and rejects escapes", () => {
    expect(linkEscapesArchive("workspace/alias", "note.md")).toBe(false);
    expect(linkEscapesArchive("workspace/link", "../victim")).toBe(false);
    expect(linkEscapesArchive("device-token", "/tmp/victim")).toBe(true);
    expect(linkEscapesArchive("workspace/alias", "../../etc/passwd")).toBe(true);
  });

  test("hardlink targets are resolved from the archive root", () => {
    expect(hardlinkEscapesArchive("workspace/note.md")).toBe(false);
    expect(hardlinkEscapesArchive("phi.db")).toBe(false);
    expect(hardlinkEscapesArchive("../victim")).toBe(true);
    expect(hardlinkEscapesArchive("/tmp/victim")).toBe(true);
    expect(() =>
      assertSafeBackupMembers([
        { name: "manifest.json", type: "file", linkname: "" },
        { name: "phi.db", type: "file", linkname: "" },
        { name: "workspace/link", type: "hardlink", linkname: "../victim" },
      ]),
    ).toThrow("link that escapes the archive");
  });
});
