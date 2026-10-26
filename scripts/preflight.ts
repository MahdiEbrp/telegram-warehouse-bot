import "dotenv/config";
import { z } from "zod";
import { createDatabase } from "../src/db/client";
import { productionConfiguration, databaseReadiness } from "../src/lib/preflight";
import { DomainError, logError } from "../src/lib/errors";

try {
  const env = productionConfiguration(process.env);
  const connection = await createDatabase({
    url: env.TURSO_DATABASE_URL,
    authToken: env.TURSO_AUTH_TOKEN,
  });
  try {
    const counts = await databaseReadiness(connection.db);
    console.log(
      JSON.stringify({
        ok: true,
        check: "production-config-and-database",
        ...counts,
        conversationVersion: `${env.CONVERSATION_VERSION}:forms-v3`,
      }),
    );
    console.log(
      "Read-only checks passed. This does not verify Telegram credentials, deployment access or webhook delivery; run webhook:info and a real /start separately.",
    );
  } finally {
    connection.close();
  }
} catch (error) {
  logError(error);
  if (error instanceof z.ZodError)
    console.error(
      "Invalid/missing env fields:",
      [...new Set(error.issues.map((issue) => issue.path.join(".")))].join(", "),
    );
  else if (error instanceof DomainError) console.error(error.message);
  else
    console.error(
      "Preflight failed. Check remote Turso configuration/connectivity without printing secrets.",
    );
  process.exitCode = 1;
}
