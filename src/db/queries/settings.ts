import { eq } from "drizzle-orm";
import { storeSettings } from "@/db/schema";
import type { Database } from "@/db/client";
import { storeInput, type StoreSettings } from "@/lib/validation";
import type { Lease } from "@/types/domain";
import { audit, mutate, requireActor } from "./common";

export const DEFAULT_STORE: StoreSettings = {
  name: "فروشگاه من",
  phone: "",
  address: "",
  paymentInstructions:
    "کارت‌به‌کارت یا انتقال بانکی؛ تأیید پرداخت به‌صورت دستی توسط مدیر انجام می‌شود.",
};
export function settingsQueries(db: Database) {
  return {
    async get(actorId: string) {
      await requireActor(db, actorId, "settings:manage");
      const [row] = await db.select().from(storeSettings).where(eq(storeSettings.id, "store"));
      return row?.value ?? DEFAULT_STORE;
    },
    async save(actorId: string, input: unknown, key: string, lease?: Lease) {
      const value = storeInput.parse(input);
      return mutate(db, actorId, "settings:manage", key, lease, async (tx) => {
        await tx
          .insert(storeSettings)
          .values({ id: "store", value })
          .onConflictDoUpdate({ target: storeSettings.id, set: { value, updatedAt: new Date() } });
        await audit(tx, actorId, "settings.update", "settings", "store", {
          fields: Object.keys(value),
        });
        return { id: "store" };
      });
    },
  };
}
