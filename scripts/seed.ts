import "dotenv/config";
import { categories, storeSettings } from "../src/db/schema";
import { getDatabase } from "../src/db";
import { DEFAULT_STORE } from "../src/db/queries/settings";

const connection = await getDatabase();
try {
  await connection.db
    .insert(categories)
    .values([{ name: "عمومی" }])
    .onConflictDoNothing();
  await connection.db
    .insert(storeSettings)
    .values({ id: "store", value: DEFAULT_STORE })
    .onConflictDoNothing();
  console.log("Seed applied (idempotent). Super admins are bootstrapped only on first /start.");
} finally {
  connection.close();
}
