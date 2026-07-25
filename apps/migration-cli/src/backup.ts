import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

export interface BackupEntry {
  path: string;
  /** Absolute path of the saved copy; null when the file did not exist. */
  copy: string | null;
  existed: boolean;
}

export interface BackupManifest {
  id: string;
  createdAt: string;
  command: string;
  entries: BackupEntry[];
}

const MANIFEST = "manifest.json";

export function defaultStateDir(env: NodeJS.ProcessEnv, home: string): string {
  return env["UMG_HOME"] ?? join(home, ".universal-mcp-gateway");
}

/**
 * Every command that edits a client config first copies the original here, so
 * `rollback` can put the user's machine back exactly as it was even when the
 * gateway itself turns out to be misconfigured.
 */
export class BackupSet {
  private readonly entries: BackupEntry[] = [];

  private constructor(
    readonly id: string,
    readonly directory: string,
    private readonly command: string,
  ) {}

  static async open(stateDir: string, command: string, id = timestampId()): Promise<BackupSet> {
    const directory = join(stateDir, "backups", id);
    await mkdir(directory, { recursive: true });
    return new BackupSet(id, directory, command);
  }

  /** Records the current contents of a file, or its absence. */
  async capture(path: string): Promise<void> {
    if (this.entries.some((entry) => entry.path === path)) return;
    let contents: string | null = null;
    try {
      contents = await readFile(path, "utf8");
    } catch {
      this.entries.push({ path, copy: null, existed: false });
      return;
    }
    const copy = join(this.directory, `${this.entries.length}-${basename(path)}`);
    await writeFile(copy, contents, "utf8");
    this.entries.push({ path, copy, existed: true });
  }

  get size(): number {
    return this.entries.length;
  }

  /** Writes the manifest; returns null when nothing was captured. */
  async commit(): Promise<BackupManifest | null> {
    if (this.entries.length === 0) {
      await rm(this.directory, { recursive: true, force: true });
      return null;
    }
    const manifest: BackupManifest = {
      id: this.id,
      createdAt: new Date().toISOString(),
      command: this.command,
      entries: this.entries,
    };
    await writeFile(
      join(this.directory, MANIFEST),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );
    return manifest;
  }
}

export async function listBackups(stateDir: string): Promise<BackupManifest[]> {
  const root = join(stateDir, "backups");
  let ids: string[];
  try {
    ids = await readdir(root);
  } catch {
    return [];
  }
  const manifests: BackupManifest[] = [];
  for (const id of ids.sort()) {
    try {
      const raw = await readFile(join(root, id, MANIFEST), "utf8");
      manifests.push(JSON.parse(raw) as BackupManifest);
    } catch {
      // A directory without a manifest is an interrupted run; ignore it.
    }
  }
  return manifests;
}

export interface RestoreResult {
  manifest: BackupManifest;
  restored: string[];
  removed: string[];
}

/** Restores the named backup, or the most recent one. */
export async function restoreBackup(
  stateDir: string,
  id?: string,
): Promise<RestoreResult | null> {
  const manifests = await listBackups(stateDir);
  const manifest = id
    ? manifests.find((candidate) => candidate.id === id)
    : manifests.at(-1);
  if (!manifest) return null;

  const restored: string[] = [];
  const removed: string[] = [];
  for (const entry of manifest.entries) {
    if (entry.existed && entry.copy) {
      await writeFile(entry.path, await readFile(entry.copy, "utf8"), "utf8");
      restored.push(entry.path);
    } else {
      // The file did not exist before the run, so putting the machine back
      // means deleting what we created.
      await rm(entry.path, { force: true });
      removed.push(entry.path);
    }
  }
  // Backups form an undo stack: once one has been applied, the next rollback
  // should step further back rather than repeat the same restore.
  await rm(join(stateDir, "backups", manifest.id), { recursive: true, force: true });
  return { manifest, restored, removed };
}

function timestampId(): string {
  const stamp = new Date().toISOString().replaceAll(/[:.]/gu, "-");
  // Two commands in the same millisecond must not share a directory.
  return `${stamp}-${randomBytes(3).toString("hex")}`;
}
