import { migrate } from "drizzle-orm/libsql/migrator";
import { resolve } from "node:path";
import { createDatabase } from "@/db/client";
import { createServices } from "@/db/queries";
export async function testDatabase(url = "file::memory:") {
  const connection = await createDatabase({ url });
  await migrate(connection.db, { migrationsFolder: resolve("drizzle") });
  const services = createServices(connection.db, { bootstrapIds: [101], timeZone: "Asia/Tehran" });
  const actor = await services.users.authenticate({
    id: 101,
    first_name: "مدیر آزمایشی",
    is_bot: false,
  });
  return { ...connection, services, actor };
}
export type TestDatabase = Awaited<ReturnType<typeof testDatabase>>;
export const testProduct = {
  name: "محصول آزمایشی",
  sku: "SKU-001",
  price: 100_000,
  stockQuantity: 10,
};
export const customer = {
  telegramId: 202,
  name: "مشتری نمونه",
  phone: "09123456789",
  address: "تهران، خیابان نمونه، پلاک ۱۲",
};
