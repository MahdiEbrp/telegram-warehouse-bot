import type { Client, Transaction, TransactionMode } from "@libsql/client";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

class LocalQueue {
  private tail: Promise<void> = Promise.resolve();
  async acquire() {
    let release!: () => void;
    const next = new Promise<void>((done) => {
      release = done;
    });
    const previous = this.tail;
    this.tail = previous.then(() => next);
    await previous;
    let done = false;
    return () => {
      if (!done) {
        done = true;
        release();
      }
    };
  }
  async run<T>(work: () => Promise<T>) {
    const release = await this.acquire();
    try {
      return await work();
    } finally {
      release();
    }
  }
}
const files = new Map<string, { queue: LocalQueue; clients: number }>();
function fileKey(url: string): string | null {
  if (url.includes(":memory:")) return null;
  const path = url.startsWith("file://")
    ? fileURLToPath(new URL(url))
    : decodeURIComponent(url.slice(5).split("?")[0]!);
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}
// libSQL's native local adapter needs one initialized connection: FK PRAGMAs are
// connection-scoped. Also avoid native BUSY cursors between same-process clients.
// This queue is a LOCAL development safeguard, NOT a distributed/serverless lock.
// Multiple production instances must use the shared remote Turso database.
export function serializeLocalClient(inner: Client, url: string): Client {
  const key = fileKey(url);
  const entry = key
    ? (files.get(key) ?? { queue: new LocalQueue(), clients: 0 })
    : { queue: new LocalQueue(), clients: 0 };
  entry.clients++;
  if (key) files.set(key, entry);
  let closed = false;
  const transactional = async (mode?: TransactionMode): Promise<Transaction> => {
    const release = await entry.queue.acquire();
    try {
      const transaction = await inner.transaction(mode);
      return new Proxy(transaction, {
        get(target, property) {
          if (property === "commit" || property === "rollback")
            return async () => {
              try {
                await target[property]();
              } finally {
                release();
              }
            };
          if (property === "close")
            return () => {
              try {
                target.close();
              } finally {
                release();
              }
            };
          const value: unknown = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    } catch (error) {
      release();
      throw error;
    }
  };
  return new Proxy(inner, {
    get(target, property) {
      if (property === "transaction") return transactional;
      if (property === "close")
        return () => {
          if (closed) return;
          closed = true;
          try {
            target.close();
          } finally {
            entry.clients--;
            if (key && entry.clients === 0) files.delete(key);
          }
        };
      if (["execute", "batch", "migrate", "executeMultiple", "sync"].includes(String(property))) {
        return (...args: unknown[]) =>
          entry.queue.run(async () => {
            const method: unknown = Reflect.get(target, property, target);
            if (typeof method !== "function") throw new Error("Invalid local database method");
            return Reflect.apply(method, target, args) as unknown;
          });
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
