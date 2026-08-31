import {
  chmodSync,
  closeSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { Database } from "bun:sqlite";

import type { CliOutput } from "@/cli";
import {
  assertSafeBackupMembers,
  linkEscapesArchive,
  listTarMembers,
  normalizeMemberName,
  unsafeArchivePath,
} from "@/commands/backup-archive";
import { dbPath, phiRoot } from "@/core/paths";
import { VERSION } from "@/version";

export { unsafeArchivePath };

export const RESTORE_IN_USE =
  "this Phi root is in use. Stop it first (`phi service stop` or quit `phi serve`), then retry.";

export const ARCHIVE_MEMBERS = [
  "phi.db",
  "workspace",
  "uploads",
  "device-token",
  "git-remote",
] as const;

const DB_SIDECARS = ["phi.db-wal", "phi.db-shm"] as const;
const MANIFEST_NAME = "manifest.json";
const ARCHIVE_FORMAT = 1;
const INCOMING_DIR = ".phi-restore-incoming";
const OUTGOING_DIR = ".phi-restore-outgoing";

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface BackupDependencies {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  now?: Date;
  runCommand?: (args: string[]) => Promise<CommandResult>;
  afterDatabaseSnapshot?: () => void | Promise<void>;
  afterInstallMember?: (name: string) => void;
}

export interface BackupManifest {
  format: number;
  phiVersion: string;
  createdAt: string;
}

const backupHelp = `Usage: phi backup [FILE]

Write a gzipped archive of this Phi root: the database, workspace, uploads,
device token, and git-remote. Model cache is skipped. The archive contains
secrets.

Default FILE is phi-backup-<timestamp>.tar.gz in the current directory.
The database snapshot is consistent while Phi is running.

Options:
  -h, --help  Show this help message
`;

const restoreHelp = `Usage: phi restore FILE --confirm

Replace this Phi root from a backup archive. Phi must not be running
(restore refuses if the database is open). Keeps the existing model cache.

Requires --confirm. The archive includes the device token.

Options:
  --confirm   Replace the current Phi root
  -h, --help  Show this help message
`;

async function defaultRunCommand(args: string[]): Promise<CommandResult> {
  const child = Bun.spawn(args, {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

function commandError(args: readonly string[], result: CommandResult): Error {
  const detail =
    result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`;
  return new Error(`\`${args.join(" ")}\` failed: ${detail}`);
}

function sqlQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function isBusyError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /busy|locked/i.test(message);
}

function isHelpFlag(argument: string): boolean {
  return argument === "-h" || argument === "--help";
}

export function backupFileName(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `phi-backup-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.tar.gz`;
}

function copyIfExists(source: string, destination: string): void {
  if (!existsSync(source)) return;
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination, { recursive: true, dereference: false });
}

function chmodRegularFile(path: string, mode: number): void {
  let stats: ReturnType<typeof lstatSync>;
  try {
    stats = lstatSync(path);
  } catch {
    return;
  }
  if (!stats.isFile()) {
    throw new Error(`${path} is not a regular file`);
  }
  try {
    chmodSync(path, mode);
  } catch {
    // Best-effort on filesystems that ignore mode.
  }
}

function snapshotDatabase(sourceDb: string, destinationDb: string): void {
  const db = new Database(sourceDb, { readonly: true, strict: true });
  try {
    db.run("PRAGMA busy_timeout = 5000");
    db.run(`VACUUM INTO ${sqlQuote(destinationDb)}`);
  } finally {
    db.close();
  }
}

function takeExclusiveLock(sourceDb: string): Database | null {
  if (!existsSync(sourceDb)) return null;
  const probe = new Database(sourceDb, { strict: true });
  try {
    probe.run("PRAGMA busy_timeout = 0");
    probe.run("PRAGMA locking_mode = EXCLUSIVE");
    probe.exec("BEGIN EXCLUSIVE");
    probe.exec("COMMIT");
    return probe;
  } catch (error) {
    probe.close();
    if (isBusyError(error)) throw new Error(RESTORE_IN_USE);
    // Corrupt or non-SQLite files are replaced by restore.
    return null;
  }
}

async function tarCreateAtomic(dest: string, staging: string): Promise<void> {
  const tmp = join(
    dirname(dest),
    `.phi-backup-${randomBytes(8).toString("hex")}.tmp`,
  );
  let fd: number | undefined;
  let renamed = false;
  try {
    fd = openSync(tmp, "wx", 0o600);
    const child = Bun.spawn(["tar", "-czf", "-", "-C", staging, "."], {
      stdin: "ignore",
      stdout: fd,
      stderr: "pipe",
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    });
    const [exitCode, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);
    closeSync(fd);
    fd = undefined;
    if (exitCode !== 0) {
      throw commandError(["tar", "-czf", "-", "-C", staging, "."], {
        exitCode,
        stdout: "",
        stderr,
      });
    }
    renameSync(tmp, dest);
    renamed = true;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Already closed.
      }
    }
    if (!renamed) {
      try {
        unlinkSync(tmp);
      } catch {
        // Best-effort cleanup of a partial archive.
      }
    }
  }
}

async function tarExtract(
  archive: string,
  destination: string,
  runCommand: (args: string[]) => Promise<CommandResult>,
): Promise<void> {
  const args = ["tar", "-xzf", archive, "-C", destination];
  const result = await runCommand(args);
  if (result.exitCode !== 0) throw commandError(args, result);
}

function pathInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function assertRegularIncomingFile(incoming: string, name: string, required: boolean): void {
  const path = join(incoming, name);
  if (!existsSync(path)) {
    if (required) throw new Error(`not a phi backup (missing ${name})`);
    return;
  }
  if (!lstatSync(path).isFile()) {
    throw new Error(`backup archive member ${name} must be a regular file`);
  }
}

function assertStagedIncoming(incoming: string): void {
  assertRegularIncomingFile(incoming, MANIFEST_NAME, true);
  assertRegularIncomingFile(incoming, "phi.db", true);
  assertRegularIncomingFile(incoming, "device-token", false);
  assertRegularIncomingFile(incoming, "git-remote", false);

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        const target = readlinkSync(path);
        const member = normalizeMemberName(relative(incoming, path));
        if (
          linkEscapesArchive(member, target) ||
          !pathInside(incoming, resolve(dir, target))
        ) {
          throw new Error("backup archive contains a link that escapes the archive");
        }
      } else if (entry.isDirectory()) {
        walk(path);
      }
    }
  };
  walk(incoming);
}

function parseManifestFile(path: string): BackupManifest {
  if (!existsSync(path)) {
    throw new Error("not a phi backup (missing manifest.json)");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("not a phi backup (invalid manifest.json)");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("not a phi backup (invalid manifest.json)");
  }
  const manifest = parsed as Partial<BackupManifest>;
  if (manifest.format !== ARCHIVE_FORMAT) {
    throw new Error(
      `unsupported backup format ${String(manifest.format ?? "unknown")}`,
    );
  }
  if (
    typeof manifest.phiVersion !== "string" ||
    typeof manifest.createdAt !== "string"
  ) {
    throw new Error("not a phi backup (invalid manifest.json)");
  }
  return {
    format: ARCHIVE_FORMAT,
    phiVersion: manifest.phiVersion,
    createdAt: manifest.createdAt,
  };
}

function parseBackupArgs(args: readonly string[]): { help: true } | { file?: string } {
  let file: string | undefined;
  for (const argument of args) {
    if (isHelpFlag(argument)) return { help: true };
    if (argument.startsWith("-")) {
      throw new Error(`unknown argument: ${argument}`);
    }
    if (file) throw new Error("Usage: phi backup [FILE]");
    file = argument;
  }
  return { file };
}

function parseRestoreArgs(
  args: readonly string[],
): { help: true } | { file: string; confirm: boolean } {
  let file: string | undefined;
  let confirm = false;
  for (const argument of args) {
    if (isHelpFlag(argument)) return { help: true };
    if (argument === "--confirm") {
      confirm = true;
      continue;
    }
    if (argument.startsWith("-")) {
      throw new Error(`unknown argument: ${argument}`);
    }
    if (file) throw new Error("Usage: phi restore FILE --confirm");
    file = argument;
  }
  if (!file) throw new Error("Usage: phi restore FILE --confirm");
  return { file, confirm };
}

function rollbackRestore(input: {
  root: string;
  outgoing: string;
  installed: readonly string[];
  movedAside: readonly string[];
}): boolean {
  let complete = true;
  for (const name of input.installed) {
    try {
      rmSync(join(input.root, name), { recursive: true, force: true });
    } catch {
      complete = false;
    }
  }
  for (const name of input.movedAside) {
    const aside = join(input.outgoing, name);
    const live = join(input.root, name);
    if (!existsSync(aside)) {
      complete = false;
      continue;
    }
    if (existsSync(live)) {
      complete = false;
      continue;
    }
    try {
      renameSync(aside, live);
    } catch {
      complete = false;
    }
  }
  return complete;
}

export async function runBackup(
  output: CliOutput,
  args: readonly string[],
  dependencies: BackupDependencies = {},
): Promise<number> {
  const parsed = parseBackupArgs(args);
  if ("help" in parsed) {
    output.stdout(backupHelp);
    return 0;
  }

  const env = dependencies.env ?? process.env;
  const cwd = dependencies.cwd ?? process.cwd();
  const now = dependencies.now ?? new Date();
  const root = phiRoot(env);
  const sourceDb = dbPath(root);
  if (!existsSync(sourceDb)) {
    throw new Error(`no phi database at ${sourceDb}`);
  }

  const dest = resolve(cwd, parsed.file ?? backupFileName(now));
  if (existsSync(dest)) {
    throw new Error(`backup file already exists: ${dest}`);
  }
  mkdirSync(dirname(dest), { recursive: true });

  const staging = mkdtempSync(join(tmpdir(), "phi-backup-"));
  try {
    snapshotDatabase(sourceDb, join(staging, "phi.db"));
    await dependencies.afterDatabaseSnapshot?.();
    for (const name of ARCHIVE_MEMBERS) {
      if (name === "phi.db") continue;
      copyIfExists(join(root, name), join(staging, name));
    }
    chmodRegularFile(join(staging, "device-token"), 0o600);
    const manifest: BackupManifest = {
      format: ARCHIVE_FORMAT,
      phiVersion: VERSION,
      createdAt: now.toISOString(),
    };
    writeFileSync(
      join(staging, MANIFEST_NAME),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    await tarCreateAtomic(dest, staging);
  } catch (error) {
    if (existsSync(dest)) {
      try {
        unlinkSync(dest);
      } catch {
        // Best-effort cleanup of a partial archive.
      }
    }
    throw error;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }

  output.stdout(`Wrote ${dest}\n`);
  return 0;
}

export async function runRestore(
  output: CliOutput,
  args: readonly string[],
  dependencies: BackupDependencies = {},
): Promise<number> {
  const parsed = parseRestoreArgs(args);
  if ("help" in parsed) {
    output.stdout(restoreHelp);
    return 0;
  }

  const env = dependencies.env ?? process.env;
  const cwd = dependencies.cwd ?? process.cwd();
  const runCommand = dependencies.runCommand ?? defaultRunCommand;
  const root = phiRoot(env);
  const archive = resolve(cwd, parsed.file);
  if (!existsSync(archive) || statSync(archive).isDirectory()) {
    throw new Error(`backup file not found: ${archive}`);
  }
  if (!parsed.confirm) {
    throw new Error(`pass --confirm to restore into ${root}`);
  }

  const members = await listTarMembers(archive);
  assertSafeBackupMembers(members);

  const incoming = join(root, INCOMING_DIR);
  const outgoing = join(root, OUTGOING_DIR);
  if (existsSync(outgoing)) {
    throw new Error(
      `incomplete restore left at ${outgoing}. Move those files back into ${root} or delete them if the current root is good.`,
    );
  }
  mkdirSync(root, { recursive: true, mode: 0o700 });
  rmSync(incoming, { recursive: true, force: true });
  mkdirSync(incoming, { recursive: true, mode: 0o700 });

  let probe: Database | null = null;
  let keepOutgoing = false;
  try {
    await tarExtract(archive, incoming, runCommand);
    assertStagedIncoming(incoming);
    parseManifestFile(join(incoming, MANIFEST_NAME));

    probe = takeExclusiveLock(dbPath(root));
    mkdirSync(outgoing, { recursive: true, mode: 0o700 });
    const movedAside: string[] = [];
    const installed: string[] = [];
    try {
      for (const name of [...ARCHIVE_MEMBERS, ...DB_SIDECARS]) {
        const live = join(root, name);
        if (existsSync(live)) {
          renameSync(live, join(outgoing, name));
          movedAside.push(name);
        }
      }
      for (const name of ARCHIVE_MEMBERS) {
        const source = join(incoming, name);
        if (!existsSync(source)) continue;
        renameSync(source, join(root, name));
        installed.push(name);
        dependencies.afterInstallMember?.(name);
      }
    } catch (error) {
      if (!rollbackRestore({ root, outgoing, installed, movedAside })) {
        keepOutgoing = true;
        throw new Error(
          `restore failed and rollback was incomplete; files are in ${outgoing}`,
        );
      }
      throw error;
    }
    chmodRegularFile(join(root, "device-token"), 0o600);
  } finally {
    probe?.close();
    rmSync(incoming, { recursive: true, force: true });
    if (!keepOutgoing) rmSync(outgoing, { recursive: true, force: true });
  }

  output.stdout(`Restored ${root} from ${archive}\n`);
  return 0;
}
