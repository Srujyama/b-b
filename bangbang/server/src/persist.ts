// Small durable store: one JSON file per named Map under DATA_DIR (default bangbang/server/.data/).
//
// - Writes are debounced and atomic (write a temp file in the same dir, then rename over the target),
//   so a crash mid-write leaves the previous good file in place.
// - Everything pending is flushed synchronously on process exit / SIGINT / SIGTERM.
// - A corrupt or unreadable file is moved aside (<name>.json.corrupt-<ts>), logged, and the map starts
//   empty — the server still boots.
// - `secret: true` files are written with mode 0600 and their contents are never logged.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Resolved data directory: $DATA_DIR (relative paths resolve against bangbang/server) or .data/. */
export function dataDir(): string {
  const d = process.env.DATA_DIR?.trim();
  return d ? resolve(SERVER_ROOT, d) : join(SERVER_ROOT, ".data");
}

export type PersistOptions = {
  /** write with mode 0600 and never log contents */
  secret?: boolean;
  /** debounce window for save() (default 200ms) */
  debounceMs?: number;
};

export type PersistedMap<V> = {
  /** the live map — mutate it, then call save() */
  readonly map: Map<string, V>;
  /** schedule a debounced atomic write */
  save(): void;
  /** write now if a save is pending (sync) */
  flush(): void;
  /** re-read from disk, replacing the map's contents (startup / restart simulation) */
  load(): void;
  /** absolute path of the backing file (for the current DATA_DIR) */
  file(): string;
  /** flush, then stop tracking this store (exit hooks no longer touch it) */
  close(): void;
};

// one registry per process, shared across module reloads, so exit hooks are installed once
type Registry = { stores: Set<{ flush(): void }>; hooked: boolean };
const REG_KEY = Symbol.for("bangbang.persist.registry");
const g = globalThis as unknown as Record<symbol, Registry | undefined>;
const registry: Registry = (g[REG_KEY] ??= { stores: new Set(), hooked: false });

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
  process.on("exit", flushAll);
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.once(sig, () => {
      flushAll();
      // keep default behaviour (terminate) unless someone else is handling this signal
      if (process.listenerCount(sig) === 0) process.kill(process.pid, sig);
    });
  }
}

/** Atomic JSON write: temp file in the same directory + rename. */
export function writeJsonAtomic(file: string, value: unknown, secret = false) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const mode = secret ? 0o600 : 0o644;
  try {
    writeFileSync(tmp, JSON.stringify(value), { mode });
    if (secret) chmodSync(tmp, 0o600); // umask can't widen it, but be explicit
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
      writeJsonAtomic(file(), Object.fromEntries(map), opts.secret);
    } catch (err) {
      dirty = true; // try again on the next save/flush
      console.error(`[persist] could not write ${name}.json: ${(err as Error).message}`);
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
      if (opts.secret) chmodSync(f, 0o600); // tighten a file someone loosened
    } catch (err) {
      map.clear();
      const aside = `${f}.corrupt-${Date.now()}`;
      let moved = "";
      try {
        renameSync(f, aside);
        if (opts.secret) chmodSync(aside, 0o600);
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
    load,
    file,
    close: () => {
      flush();
      registry.stores.delete(store);
    },
  };
  registry.stores.add(store);
  installExitHooks();
  load();
  return store;
}
