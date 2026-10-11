// Small durable store: one JSON file per named Map under DATA_DIR (default vellum/server/.data/).
//
// - Writes are debounced and atomic (write a temp file in the same dir, then rename over the target),
//   so a crash mid-write leaves the previous good file in place.
// - Everything pending is flushed synchronously on process exit / SIGINT / SIGTERM.
// - A corrupt or unreadable file is moved aside (<name>.json.corrupt-<ts>), logged, and the map starts
//   empty — the server still boots.
// - Every file is written with mode 0600 (cases.json holds patient bill details and names; escrows.json
//   holds escrow release keys). `secret: true` additionally means contents are never logged.
// - `strict: true` stores re-throw write errors from flush() instead of only logging them, so a caller
//   that must not acknowledge something until it is on disk (escrow release keys) can fail loudly.
// - ONE SERVER PER DATA_DIR. Two processes sharing a DATA_DIR would overwrite each other's files (last
//   writer wins). The first write takes DATA_DIR/.lock (holding our pid); a write while another live
//   process holds it fails loudly instead of clobbering. The lock is released on exit; a lock left by a
//   dead process is taken over. Reads never need the lock (writes are atomic renames).
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Resolved data directory: $DATA_DIR (relative paths resolve against vellum/server) or .data/. */
export function dataDir(): string {
  const d = process.env.DATA_DIR?.trim();
  return d ? resolve(SERVER_ROOT, d) : join(SERVER_ROOT, ".data");
}

export type PersistOptions = {
  /** never log contents (files are always written 0600) */
  secret?: boolean;
  /** flush() re-throws write errors (the store stays dirty, so a later flush retries) */
  strict?: boolean;
  /** debounce window for save() (default 200ms) */
  debounceMs?: number;
};

export type PersistedMap<V> = {
  /** the live map — mutate it, then call save() */
  readonly map: Map<string, V>;
  /** schedule a debounced atomic write */
  save(): void;
  /** write now if a save is pending (sync). Logs write errors; re-throws them if `strict`. */
  flush(): void;
  /** take the DATA_DIR lock now (throws if another live process holds it) — call before an
   *  irreversible action whose result must then be written here */
  claim(): void;
  /** re-read from disk, replacing the map's contents (startup / restart simulation) */
  load(): void;
  /** absolute path of the backing file (for the current DATA_DIR) */
  file(): string;
  /** flush, then stop tracking this store (exit hooks no longer touch it) */
  close(): void;
};

// one registry per process, shared across module reloads, so exit hooks are installed once
type Registry = { stores: Set<{ flush(): void }>; hooked: boolean; locks: Set<string> };
const REG_KEY = Symbol.for("vellum.persist.registry");
const g = globalThis as unknown as Record<symbol, Registry | undefined>;
const registry: Registry = (g[REG_KEY] ??= { stores: new Set(), hooked: false, locks: new Set() });
registry.locks ??= new Set();

const FILE_MODE = 0o600;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM"; // exists, owned by someone else
  }
}

/** Take DATA_DIR/.lock for this process (idempotent). Throws if another live process holds it. */
export function claimDataDir(dir = dataDir()) {
  if (registry.locks.has(dir)) return;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lock = join(dir, ".lock");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(lock, String(process.pid), { flag: "wx", mode: FILE_MODE });
      registry.locks.add(dir);
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    const holder = Number(readFileSync(lock, "utf8").trim());
    if (holder === process.pid) {
      registry.locks.add(dir);
      return;
    }
    if (Number.isInteger(holder) && holder > 0 && pidAlive(holder)) {
      throw Object.assign(
        new Error(
          `DATA_DIR ${dir} is in use by another Vellum process (pid ${holder}). Run one server per DATA_DIR: ` +
            `stop that process or set DATA_DIR to a different directory (if pid ${holder} is not Vellum, delete ${lock}).`,
        ),
        { statusCode: 503 },
      );
    }
    unlinkSync(lock); // stale: holder is gone — take it over
  }
  throw new Error(`could not take ${lock}`);
}

function releaseLocks() {
  for (const dir of registry.locks) {
    const lock = join(dir, ".lock");
    try {
      if (Number(readFileSync(lock, "utf8").trim()) === process.pid) unlinkSync(lock);
    } catch {
      /* already gone */
    }
  }
  registry.locks.clear();
}

/** Flush every pending store synchronously. */
export function flushAll() {
  for (const s of registry.stores) {
    try {
      s.flush();
    } catch (err) {
      console.error(`[persist] flush failed: ${(err as Error).message}`);
    }
  }
}

function installExitHooks() {
  if (registry.hooked) return;
  registry.hooked = true;
  process.on("exit", () => {
    flushAll();
    releaseLocks();
  });
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.once(sig, () => {
      flushAll();
      // re-raising the signal below terminates without an "exit" event, so release here too
      // (if someone else handles the signal and we keep running, the next write re-takes the lock)
      releaseLocks();
      // keep default behaviour (terminate) unless someone else is handling this signal
      if (process.listenerCount(sig) === 0) process.kill(process.pid, sig);
    });
  }
}

/** Atomic JSON write: temp file in the same directory + rename. */
export function writeJsonAtomic(file: string, value: unknown) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(value), { mode: FILE_MODE });
    chmodSync(tmp, FILE_MODE); // the mode only applies on create; be explicit
    renameSync(tmp, file);
  } catch (err) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw err;
  }
}

/** A Map<string, V> backed by DATA_DIR/<name>.json. Loads immediately. */
export function persistedMap<V>(name: string, opts: PersistOptions = {}): PersistedMap<V> {
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(name)) throw new Error(`persist: bad store name ${name}`);
  const map = new Map<string, V>();
  const debounceMs = opts.debounceMs ?? 200;
  let timer: NodeJS.Timeout | undefined;
  let dirty = false;
  const file = () => join(dataDir(), `${name}.json`);

  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (!dirty) return;
    dirty = false;
    try {
      claimDataDir();
      writeJsonAtomic(file(), Object.fromEntries(map));
    } catch (err) {
      dirty = true; // try again on the next save/flush
      console.error(`[persist] could not write ${name}.json: ${(err as Error).message}`);
      if (opts.strict) throw err;
    }
  };

  const save = () => {
    dirty = true;
    if (timer) return;
    timer = setTimeout(flush, debounceMs);
    timer.unref?.();
  };

  const load = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    dirty = false;
    map.clear();
    const f = file();
    if (!existsSync(f)) return;
    try {
      const raw = JSON.parse(readFileSync(f, "utf8"));
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("not a JSON object");
      for (const [k, v] of Object.entries(raw)) map.set(k, v as V);
      try {
        if ((statSync(f).mode & 0o777) !== FILE_MODE) chmodSync(f, FILE_MODE); // tighten a loosened file
      } catch {
        /* not ours to chmod — still readable, keep going */
      }
    } catch (err) {
      map.clear();
      const aside = `${f}.corrupt-${Date.now()}`;
      let moved = "";
      try {
        renameSync(f, aside);
        chmodSync(aside, FILE_MODE);
        moved = ` (moved to ${aside})`;
      } catch {
        /* leave it */
      }
      // message only — never the file contents (may hold escrow fulfillments)
      // (a JSON SyntaxError message quotes the input, so it is not printed either)
      const why = err instanceof SyntaxError ? "invalid JSON" : (err as Error).message.slice(0, 120);
      console.error(`[persist] ${name}.json is unreadable, starting empty${moved}: ${why}`);
    }
  };

  const store: PersistedMap<V> = {
    map,
    save,
    flush,
    claim: () => claimDataDir(),
    load,
    file,
    close: () => {
      try {
        flush();
      } finally {
        registry.stores.delete(store);
      }
    },
  };
  registry.stores.add(store);
  installExitHooks();
  load();
  return store;
}
