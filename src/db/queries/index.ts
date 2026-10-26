import type { Database } from "@/db/client";
import { userQueries } from "./users";
import { productQueries } from "./products";
import { orderQueries } from "./orders";
import { reportQueries } from "./reports";
import { settingsQueries } from "./settings";
import { shipmentQueries } from "./shipments";
import { exportQueries } from "./exports";
export function createServices(
  db: Database,
  config: { bootstrapIds: readonly number[]; timeZone: string },
) {
  return {
    users: userQueries(db, config.bootstrapIds),
    products: productQueries(db),
    orders: orderQueries(db),
    shipments: shipmentQueries(db),
    exports: exportQueries(db, config.timeZone),
    reports: reportQueries(db, config.timeZone),
    settings: settingsQueries(db),
  };
}
export type Services = ReturnType<typeof createServices>;
