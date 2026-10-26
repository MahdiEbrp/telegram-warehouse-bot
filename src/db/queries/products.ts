import { and, asc, eq, or, sql } from "drizzle-orm";
import { z } from "zod";
import { categories, inventoryLogs, products } from "@/db/schema";
import type { Database } from "@/db/client";
import { productInput, productPatch, nameInput, uuid } from "@/lib/validation";
import { invariant } from "@/lib/errors";
import { MAX_STOCK, type Lease } from "@/types/domain";
import { audit, countAll, mutate, pagination, pageResult, requireActor } from "./common";

export function productQueries(db: Database) {
  return {
    async list(actorId: string, requestedPage = 0, search = "") {
      await requireActor(db, actorId, "products:read");
      const term = search.slice(0, 100).replace(/[\\%_]/g, (c) => `\\${c}`);
      const where = and(
        eq(products.isActive, true),
        term
          ? or(
              sql`${products.name} like ${`%${term}%`} escape '\\'`,
              sql`${products.sku} like ${`%${term.toUpperCase()}%`} escape '\\'`,
            )
          : undefined,
      );
      const [row] = await db.select({ count: countAll }).from(products).where(where);
      const p = pagination(row?.count ?? 0, requestedPage);
      return pageResult(
        p,
        await db
          .select()
          .from(products)
          .where(where)
          .orderBy(asc(products.name), products.id)
          .limit(p.pageSize)
          .offset(p.offset),
      );
    },
    async get(actorId: string, id: string) {
      await requireActor(db, actorId, "products:read");
      uuid.parse(id);
      const [product] = await db.select().from(products).where(eq(products.id, id)).limit(1);
      invariant(product, "NOT_FOUND", "محصول یافت نشد.");
      return product;
    },
    async categories(actorId: string, requestedPage = 0) {
      await requireActor(db, actorId, "products:read");
      const [row] = await db.select({ count: countAll }).from(categories);
      const p = pagination(row?.count ?? 0, requestedPage);
      return pageResult(
        p,
        await db
          .select()
          .from(categories)
          .orderBy(categories.name, categories.id)
          .limit(p.pageSize)
          .offset(p.offset),
      );
    },
    async getCategory(actorId: string, id: string) {
      await requireActor(db, actorId, "products:read");
      uuid.parse(id);
      const [category] = await db
        .select({ id: categories.id, name: categories.name })
        .from(categories)
        .where(eq(categories.id, id))
        .limit(1);
      invariant(category, "NOT_FOUND", "دسته‌بندی یافت نشد.");
      return category;
    },
    async createCategory(
      actorId: string,
      name: string,
      parentId: string | null,
      key: string,
      lease?: Lease,
    ) {
      const value = z
        .object({ name: nameInput, parentId: uuid.nullable() })
        .parse({ name, parentId });
      return mutate(db, actorId, "products:write", key, lease, async (tx) => {
        if (value.parentId) {
          const [parent] = await tx
            .select({ id: categories.id })
            .from(categories)
            .where(eq(categories.id, value.parentId));
          invariant(parent, "NOT_FOUND", "دسته‌بندی والد یافت نشد.");
        }
        const [category] = await tx
          .insert(categories)
          .values(value)
          .returning({ id: categories.id });
        invariant(category, "NOT_FOUND", "ساخت دسته‌بندی ناموفق بود.");
        await audit(tx, actorId, "category.create", "category", category.id, { parentId });
        return category;
      });
    },
    async create(actorId: string, input: unknown, key: string, lease?: Lease) {
      const value = productInput.parse(input);
      return mutate(db, actorId, "products:write", key, lease, async (tx) => {
        if (value.categoryId) {
          const [category] = await tx
            .select({ id: categories.id })
            .from(categories)
            .where(eq(categories.id, value.categoryId));
          invariant(category, "NOT_FOUND", "دسته‌بندی یافت نشد.");
        }
        const [product] = await tx.insert(products).values(value).returning({ id: products.id });
        invariant(product, "NOT_FOUND", "افزودن محصول ناموفق بود.");
        if (value.stockQuantity > 0)
          await tx.insert(inventoryLogs).values({
            productId: product.id,
            changeType: "in",
            quantityChange: value.stockQuantity,
            previousStock: 0,
            newStock: value.stockQuantity,
            userId: actorId,
            note: "موجودی اولیه",
          });
        await audit(tx, actorId, "product.create", "product", product.id, {
          sku: value.sku,
          price: value.price,
          stockQuantity: value.stockQuantity,
        });
        return product;
      });
    },
    async update(actorId: string, id: string, input: unknown, key: string, lease?: Lease) {
      uuid.parse(id);
      const patch = productPatch.parse(input);
      return mutate(db, actorId, "products:write", key, lease, async (tx) => {
        if (patch.categoryId) {
          const [category] = await tx
            .select({ id: categories.id })
            .from(categories)
            .where(eq(categories.id, patch.categoryId));
          invariant(category, "NOT_FOUND", "دسته‌بندی یافت نشد.");
        }
        const [updated] = await tx
          .update(products)
          .set({ ...patch, updatedAt: new Date() })
          .where(and(eq(products.id, id), eq(products.isActive, true)))
          .returning({ id: products.id });
        invariant(updated, "NOT_FOUND", "محصول فعال یافت نشد.");
        await audit(tx, actorId, "product.update", "product", id, { fields: Object.keys(patch) });
        return updated;
      });
    },
    async archive(actorId: string, id: string, key: string, lease?: Lease) {
      uuid.parse(id);
      return mutate(db, actorId, "products:write", key, lease, async (tx) => {
        const [product] = await tx.select().from(products).where(eq(products.id, id));
        invariant(product, "NOT_FOUND", "محصول یافت نشد.");
        if (product.isActive) {
          await tx
            .update(products)
            .set({ isActive: false, updatedAt: new Date() })
            .where(eq(products.id, id));
          await audit(tx, actorId, "product.archive", "product", id, {});
        }
        return { id };
      });
    },
    async adjustStock(
      actorId: string,
      id: string,
      expectedStock: number,
      newStock: number,
      key: string,
      lease?: Lease,
    ) {
      uuid.parse(id);
      z.number().int().min(0).max(MAX_STOCK).parse(newStock);
      return mutate(db, actorId, "inventory:write", key, lease, async (tx) => {
        const [product] = await tx
          .select()
          .from(products)
          .where(and(eq(products.id, id), eq(products.isActive, true)));
        invariant(product, "NOT_FOUND", "محصول فعال یافت نشد.");
        invariant(
          product.stockQuantity === expectedStock,
          "STOCK_CHANGED",
          "موجودی هم‌زمان تغییر کرده است؛ صفحه محصول را دوباره باز کنید.",
        );
        if (newStock !== product.stockQuantity) {
          await tx
            .update(products)
            .set({ stockQuantity: newStock, updatedAt: new Date() })
            .where(eq(products.id, id));
          await tx.insert(inventoryLogs).values({
            productId: id,
            changeType: "adjustment",
            quantityChange: newStock - product.stockQuantity,
            previousStock: product.stockQuantity,
            newStock,
            userId: actorId,
            note: "تنظیم دستی موجودی",
          });
          await audit(tx, actorId, "inventory.adjust", "product", id, {
            previousStock: product.stockQuantity,
            newStock,
          });
        }
        return { id, stockQuantity: newStock };
      });
    },
  };
}
