import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile, rm, readdir, stat, rename } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000; // 6 horas

export function cacheDir(): string {
  return process.env.SUNAT_CACHE_DIR || path.join(os.homedir(), ".sunat-mcp-cache");
}

export function cacheTtlMs(): number {
  const env = process.env.SUNAT_CACHE_TTL_MS;
  if (env === undefined || env === "") return DEFAULT_TTL_MS;
  const parsed = Number(env);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_TTL_MS;
}

function keyToFile(key: string): string {
  const hash = createHash("sha256").update(key).digest("hex");
  return path.join(cacheDir(), `${hash}.json`);
}

interface CacheEntry<T> {
  key: string;
  timestamp: number;
  data: T;
}

export async function getCached<T>(key: string, ttlMs: number): Promise<T | null> {
  if (ttlMs <= 0) return null;
  try {
    const raw = await readFile(keyToFile(key), "utf-8");
    const entry = JSON.parse(raw) as CacheEntry<T>;
    if (Date.now() - entry.timestamp > ttlMs) return null;
    return entry.data;
  } catch {
    return null;
  }
}

/**
 * Escritura atomica (tmp + rename): dos procesos MCP/CLI en paralelo pueden escribir
 * la misma clave sin dejar un JSON a medias que envenene la cache.
 */
export async function setCached<T>(key: string, data: T): Promise<void> {
  const destino = keyToFile(key);
  const tmp = `${destino}.${randomBytes(6).toString("hex")}.tmp`;
  const entry: CacheEntry<T> = { key, timestamp: Date.now(), data };
  try {
    await mkdir(cacheDir(), { recursive: true });
    await writeFile(tmp, JSON.stringify(entry), "utf-8");
    await rename(tmp, destino);
  } catch {
    // La cache es un acelerador, no una fuente de verdad: si falla, se sigue sin ella.
    await rm(tmp, { force: true }).catch(() => {});
  }
}

/** Envuelve una funcion costosa con cache en disco. Los errores nunca se cachean. */
export async function conCache<T>(key: string, fn: () => Promise<T>, ttlMs = cacheTtlMs()): Promise<T> {
  const cached = await getCached<T>(key, ttlMs);
  if (cached !== null) return cached;
  const data = await fn();
  await setCached(key, data);
  return data;
}

export async function clearCache(): Promise<void> {
  await rm(cacheDir(), { recursive: true, force: true });
}

export interface CacheStats {
  directorio: string;
  entradas: number;
  bytes: number;
  ttl_ms: number;
  mas_antigua: string | null;
}

export async function cacheStats(): Promise<CacheStats> {
  const dir = cacheDir();
  const base: CacheStats = { directorio: dir, entradas: 0, bytes: 0, ttl_ms: cacheTtlMs(), mas_antigua: null };
  let archivos: string[];
  try {
    archivos = await readdir(dir);
  } catch {
    return base;
  }
  let masAntigua = Number.POSITIVE_INFINITY;
  for (const f of archivos) {
    if (!f.endsWith(".json")) continue;
    try {
      const s = await stat(path.join(dir, f));
      base.entradas++;
      base.bytes += s.size;
      masAntigua = Math.min(masAntigua, s.mtimeMs);
    } catch {
      /* archivo borrado entre readdir y stat */
    }
  }
  if (Number.isFinite(masAntigua)) base.mas_antigua = new Date(masAntigua).toISOString();
  return base;
}
