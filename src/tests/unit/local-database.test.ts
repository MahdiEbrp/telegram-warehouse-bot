import { describe, expect, it } from "vitest";
import { testDatabase } from "../helpers/database";
import { users } from "@/db/schema";
function gate() {
  let done!: () => void;
  const promise = new Promise<void>((resolve) => {
    done = resolve;
  });
  return { promise, done };
}
describe("local libSQL initialized-connection serialization", () => {
  it("queues an outside read behind an open transaction instead of opening an uninitialized connection", async () => {
    const t = await testDatabase();
    const entered = gate(),
      finish = gate();
    try {
      const writer = t.db.transaction(async (tx) => {
        await tx.select().from(users);
        entered.done();
        await finish.promise;
      });
      await entered.promise;
      let completed = false;
      const reader = t.db
        .select()
        .from(users)
        .then((rows) => {
          completed = true;
          return rows;
        });
      await Promise.resolve();
      expect(completed).toBe(false);
      finish.done();
      await writer;
      expect(await reader).toHaveLength(1);
      expect(Number((await t.client.execute("PRAGMA foreign_keys")).rows[0]?.foreign_keys)).toBe(1);
    } finally {
      finish.done();
      t.close();
    }
  });
  it("releases the local queue after rollback and never commits a failed callback", async () => {
    const t = await testDatabase();
    try {
      await expect(
        t.db.transaction(async (tx) => {
          await tx.insert(users).values({ telegramId: 303, firstName: "rollback" });
          throw new Error("intentional failure");
        }),
      ).rejects.toThrow("intentional failure");
      expect(await t.db.select().from(users)).toHaveLength(1);
      await t.db.transaction(async (tx) => {
        await tx.insert(users).values({ telegramId: 303, firstName: "committed" });
      });
      expect(await t.db.select().from(users)).toHaveLength(2);
    } finally {
      t.close();
    }
  });
});
