import { createClient, type Client } from "@libsql/client";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import * as schema from "./schema";
import { serializeLocalClient } from "./local-serialization";

export type Database = LibSQLDatabase<typeof schema>;
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
export type Executor = Database | Transaction;
export interface DatabaseConnection {
  db: Database;
  client: Client;
  close(): void;
}
export async function createDatabase(config: {
  url: string;
  authToken?: string;
}): Promise<DatabaseConnection> {
  const local = config.url.startsWith("file:");
  const rawClient = createClient({
    url: config.url,
    authToken: config.authToken,
    intMode: "number",
    ...(local ? { concurrency: 1 } : {}),
  });
  const client = local ? serializeLocalClient(rawClient, config.url) : rawClient;
  try {
    await client.execute("PRAGMA foreign_keys = ON");
    const pragma = await client.execute("PRAGMA foreign_keys");
    if (Number(pragma.rows[0]?.foreign_keys) !== 1)
      throw new Error("Foreign key enforcement must be enabled");
    if (config.url.startsWith("file:")) await client.execute("PRAGMA busy_timeout = 5000");
    return { db: drizzle(client, { schema }), client, close: () => client.close() };
  } catch (error) {
    client.close();
    throw error;
  }
}
