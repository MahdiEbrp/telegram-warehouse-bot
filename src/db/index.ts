import { createDatabase, type DatabaseConnection } from "./client";
import { parseDatabaseEnv } from "@/lib/env";
const state = globalThis as typeof globalThis & { warehouseDb?: Promise<DatabaseConnection> };
export function getDatabase(): Promise<DatabaseConnection> {
  if (!state.warehouseDb) {
    const env = parseDatabaseEnv(process.env);
    state.warehouseDb = createDatabase({
      url: env.TURSO_DATABASE_URL,
      authToken: env.TURSO_AUTH_TOKEN,
    }).catch((error) => {
      state.warehouseDb = undefined;
      throw error;
    });
  }
  return state.warehouseDb;
}
