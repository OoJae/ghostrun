// Structural slices of the Workers runtime types this API touches. Declaring only what we call
// keeps the package typechecking (and unit-testable under Node) without the global declarations
// of @cloudflare/workers-types, which clash with the DOM lib the handler is written against.
export interface WaitUntil {
  waitUntil(p: Promise<unknown>): void;
}

export interface DoStub {
  fetch(input: string, init?: RequestInit): Promise<Response>;
}

export interface DoNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): DoStub;
}

export type SqlValue = string | number | null | ArrayBuffer;

export interface SqlStorage {
  exec(query: string, ...bindings: SqlValue[]): { toArray(): Record<string, SqlValue>[] };
}

export interface DoStorage {
  sql: SqlStorage;
  transactionSync<T>(fn: () => T): T;
}

export interface DoState {
  storage: DoStorage;
  waitUntil?(p: Promise<unknown>): void;
}

export interface R2Bucket {
  get(key: string): Promise<{ text(): Promise<string> } | null>;
  head(key: string): Promise<object | null>;
  put(key: string, value: string, options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }): Promise<unknown>;
  /** Keys in ascending (UTF-8 byte) order. */
  list(options: { prefix?: string; limit?: number; include?: ("httpMetadata" | "customMetadata")[] }): Promise<{ objects: { key: string; customMetadata?: Record<string, string> }[] }>;
}

export interface KvNamespace {
  get(key: string, options?: { cacheTtl?: number }): Promise<string | null>;
  /** Only the canaries write (their last results); a flag is set by hand. */
  put?(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

/** What a cron trigger hands the scheduled handler. */
export interface ScheduledController {
  cron: string;
  scheduledTime: number;
}
