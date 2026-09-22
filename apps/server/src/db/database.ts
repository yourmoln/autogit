import { createRequire } from 'node:module';
import type * as NodeSqlite from 'node:sqlite';

// `node:sqlite` is loaded through createRequire on purpose: bundlers currently
// rewrite the `node:` prefix to a bare `sqlite` specifier, which does not exist
// as a package. This keeps the built output working.
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite') as typeof NodeSqlite;

export type SqlValue = string | number | bigint | null | Uint8Array;

export interface RunOutcome {
  changes: number;
  lastInsertRowid: number;
}

/**
 * Thin, typed wrapper around the built-in `node:sqlite` driver. Using the
 * platform driver keeps the install footprint at zero native dependencies,
 * which matters a lot for a desktop tool that users install with pnpm.
 */
export class Db {
  private readonly raw: NodeSqlite.DatabaseSync;

  constructor(file: string) {
    this.raw = new DatabaseSync(file);
    this.raw.exec('PRAGMA journal_mode = WAL');
    this.raw.exec('PRAGMA foreign_keys = ON');
    this.raw.exec('PRAGMA synchronous = NORMAL');
    this.raw.exec('PRAGMA busy_timeout = 5000');
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  run(sql: string, params: SqlValue[] = []): RunOutcome {
    const statement = this.raw.prepare(sql);
    const result = statement.run(...params);
    return {
      changes: Number(result.changes ?? 0),
      lastInsertRowid: Number(result.lastInsertRowid ?? 0),
    };
  }

  get<T>(sql: string, params: SqlValue[] = []): T | null {
    const statement = this.raw.prepare(sql);
    const row = statement.get(...params);
    return (row as T | undefined) ?? null;
  }

  all<T>(sql: string, params: SqlValue[] = []): T[] {
    const statement = this.raw.prepare(sql);
    return statement.all(...params) as T[];
  }

  transaction<T>(fn: () => T): T {
    this.raw.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.raw.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.raw.exec('ROLLBACK');
      } catch {
        // ignore rollback failures, the original error is more useful
      }
      throw error;
    }
  }

  close(): void {
    this.raw.close();
  }
}

export function bool(value: boolean): number {
  return value ? 1 : 0;
}

export function fromBool(value: unknown): boolean {
  return value === 1 || value === true || value === '1';
}

export function parseJsonArray(value: unknown): string[] {
  if (typeof value !== 'string' || value.length === 0) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === 'string');
  } catch {
    return [];
  }
}

export function parseJsonObject<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
