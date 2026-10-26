import { relations, sql } from "drizzle-orm";
import {
  sqliteTable,
  text,
  integer,
  index,
  uniqueIndex,
  check,
  type AnySQLiteColumn,
} from "drizzle-orm/sqlite-core";
import { randomUUID } from "node:crypto";
import {
  roles,
  orderStatuses,
  paymentStatuses,
  inventoryChangeTypes,
  carriers,
  shipmentStates,
  type Json,
} from "@/types/domain";
import type { StoreSettings } from "@/lib/validation";

const id = () => text("id").primaryKey().$defaultFn(randomUUID);
const created = () =>
  integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date());
const updated = () =>
  integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date());
export const users = sqliteTable(
  "users",
  {
    id: id(),
    telegramId: integer("telegram_id").notNull().unique(),
    firstName: text("first_name").notNull(),
    lastName: text("last_name"),
    username: text("username"),
    role: text("role", { enum: roles }).notNull().default("viewer"),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(false),
    createdAt: created(),
  },
  (t) => [
    index("users_role_active_idx").on(t.role, t.isActive),
    check("users_role_check", sql`${t.role} in ('super_admin','admin','operator','viewer')`),
    check("users_telegram_check", sql`${t.telegramId} > 0 and ${t.telegramId} <= 9007199254740991`),
  ],
);
export const categories = sqliteTable(
  "categories",
  {
    id: id(),
    name: text("name").notNull().unique(),
    parentId: text("parent_id").references((): AnySQLiteColumn => categories.id, {
      onDelete: "restrict",
    }),
  },
  (t) => [
    index("categories_parent_idx").on(t.parentId),
    check("categories_not_self", sql`${t.parentId} is null or ${t.parentId} <> ${t.id}`),
  ],
);
export const products = sqliteTable(
  "products",
  {
    id: id(),
    name: text("name").notNull(),
    sku: text("sku").notNull().unique(),
    description: text("description"),
    price: integer("price").notNull(),
    costPrice: integer("cost_price").notNull().default(0),
    stockQuantity: integer("stock_quantity").notNull().default(0),
    minStockLevel: integer("min_stock_level").notNull().default(5),
    categoryId: text("category_id").references(() => categories.id, { onDelete: "restrict" }),
    imageUrl: text("image_url"),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [
    index("products_category_idx").on(t.categoryId),
    index("products_active_stock_idx").on(t.isActive, t.stockQuantity),
    index("products_active_name_idx").on(t.isActive, t.name),
    check(
      "products_price_check",
      sql`${t.price} between 0 and 1000000000000 and ${t.costPrice} between 0 and 1000000000000`,
    ),
    check(
      "products_stock_check",
      sql`${t.stockQuantity} between 0 and 1000000 and ${t.minStockLevel} between 0 and 1000000`,
    ),
  ],
);
export const orders = sqliteTable(
  "orders",
  {
    id: id(),
    orderNumber: text("order_number").notNull().unique(),
    customerTelegramId: integer("customer_telegram_id")
      .notNull()
      .references(() => users.telegramId, { onDelete: "restrict" }),
    customerName: text("customer_name").notNull(),
    customerPhone: text("customer_phone").notNull(),
    shippingAddress: text("shipping_address").notNull(),
    totalAmount: integer("total_amount").notNull(),
    status: text("status", { enum: orderStatuses }).notNull().default("pending"),
    paymentStatus: text("payment_status", { enum: paymentStatuses }).notNull().default("unpaid"),
    notes: text("notes"),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [
    index("orders_customer_idx").on(t.customerTelegramId),
    index("orders_status_created_idx").on(t.status, t.createdAt),
    index("orders_payment_created_idx").on(t.paymentStatus, t.createdAt),
    check(
      "orders_status_check",
      sql`${t.status} in ('pending','confirmed','processing','shipped','delivered','cancelled')`,
    ),
    check("orders_payment_check", sql`${t.paymentStatus} in ('unpaid','paid','refunded')`),
    check("orders_total_check", sql`${t.totalAmount} between 0 and 9007199254740991`),
  ],
);
// One-to-one reference table avoids rebuilding orders or touching existing FKs on upgrade.
export const orderReferences = sqliteTable(
  "order_references",
  {
    orderId: text("order_id")
      .primaryKey()
      .references(() => orders.id, { onDelete: "restrict" }),
    code: text("code").notNull().unique(),
    createdAt: created(),
  },
  (t) => [
    check(
      "order_reference_code_check",
      sql`length(${t.code}) = 16 and substr(${t.code}, 1, 4) = 'REF-' and substr(${t.code}, 5) not glob '*[^A-Z0-9]*'`,
    ),
  ],
);
export const shipments = sqliteTable(
  "shipments",
  {
    id: id(),
    orderId: text("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "restrict" }),
    parcelNumber: integer("parcel_number").notNull().default(1),
    state: text("state", { enum: shipmentStates }).notNull().default("draft"),
    carrier: text("carrier", { enum: carriers }).notNull(),
    carrierName: text("carrier_name").notNull().default(""),
    trackingNumber: text("tracking_number"),
    trackingUrl: text("tracking_url"),
    postalCode: text("postal_code"),
    shippingCost: integer("shipping_cost").notNull().default(0),
    note: text("note").notNull().default(""),
    version: integer("version").notNull().default(1),
    dispatchedAt: integer("dispatched_at", { mode: "timestamp_ms" }),
    deliveredAt: integer("delivered_at", { mode: "timestamp_ms" }),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    updatedBy: text("updated_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [
    uniqueIndex("shipments_carrier_tracking_idx").on(t.carrier, t.carrierName, t.trackingNumber),
    uniqueIndex("shipments_order_parcel_idx").on(t.orderId, t.parcelNumber),
    index("shipments_order_state_idx").on(t.orderId, t.state),
    check("shipments_parcel_number_check", sql`${t.parcelNumber} > 0`),
    check("shipments_state_check", sql`${t.state} in ('draft','dispatched','delivered')`),
    index("shipments_dispatched_idx").on(t.dispatchedAt),
    index("shipments_created_by_idx").on(t.createdBy),
    index("shipments_updated_by_idx").on(t.updatedBy),
    check(
      "shipments_carrier_check",
      sql`${t.carrier} in ('iran_post','tipax','chapar','courier','pickup','other')`,
    ),
    check(
      "shipments_tracking_check",
      sql`${t.trackingNumber} is null or length(${t.trackingNumber}) between 4 and 64`,
    ),
    check(
      "shipments_required_tracking_check",
      sql`${t.carrier} in ('courier','pickup') or ${t.trackingNumber} is not null`,
    ),
    check(
      "shipments_carrier_name_check",
      sql`(${t.carrier} = 'other' and length(${t.carrierName}) between 2 and 60) or (${t.carrier} <> 'other' and ${t.carrierName} = '')`,
    ),
    check(
      "shipments_cost_version_check",
      sql`${t.shippingCost} between 0 and 1000000000000 and ${t.version} > 0`,
    ),
    check(
      "shipments_postal_check",
      sql`${t.postalCode} is null or (length(${t.postalCode}) = 10 and ${t.postalCode} not glob '*[^0-9]*')`,
    ),
    check(
      "shipments_dates_check",
      sql`${t.deliveredAt} is null or ${t.dispatchedAt} is null or ${t.deliveredAt} >= ${t.dispatchedAt}`,
    ),
  ],
);
// Persistent counter prevents reusing a parcel number after clearing a draft.
export const shipmentSequences = sqliteTable(
  "shipment_sequences",
  {
    orderId: text("order_id")
      .primaryKey()
      .references(() => orders.id, { onDelete: "restrict" }),
    lastNumber: integer("last_number").notNull(),
  },
  (t) => [check("shipment_sequence_check", sql`${t.lastNumber} between 1 and 9007199254740991`)],
);
export const orderItems = sqliteTable(
  "order_items",
  {
    id: id(),
    orderId: text("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "restrict" }),
    productId: text("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    quantity: integer("quantity").notNull(),
    unitPrice: integer("unit_price").notNull(),
    totalPrice: integer("total_price").notNull(),
  },
  (t) => [
    uniqueIndex("order_items_order_product_idx").on(t.orderId, t.productId),
    index("order_items_product_idx").on(t.productId),
    check(
      "order_items_amount_check",
      sql`${t.quantity} between 1 and 1000000 and ${t.unitPrice} >= 0 and ${t.totalPrice} = ${t.quantity} * ${t.unitPrice} and ${t.totalPrice} <= 9007199254740991`,
    ),
  ],
);
export const inventoryLogs = sqliteTable(
  "inventory_logs",
  {
    id: id(),
    productId: text("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    changeType: text("change_type", { enum: inventoryChangeTypes }).notNull(),
    quantityChange: integer("quantity_change").notNull(),
    previousStock: integer("previous_stock").notNull(),
    newStock: integer("new_stock").notNull(),
    referenceId: text("reference_id").references(() => orders.id, { onDelete: "restrict" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    note: text("note"),
    createdAt: created(),
  },
  (t) => [
    index("inventory_product_created_idx").on(t.productId, t.createdAt),
    index("inventory_created_idx").on(t.createdAt),
    index("inventory_reference_idx").on(t.referenceId),
    index("inventory_user_idx").on(t.userId),
    check("inventory_type_check", sql`${t.changeType} in ('in','out','adjustment')`),
    check(
      "inventory_balance_check",
      sql`${t.newStock} = ${t.previousStock} + ${t.quantityChange} and ${t.previousStock} between 0 and 1000000 and ${t.newStock} between 0 and 1000000`,
    ),
    check(
      "inventory_sign_check",
      sql`(${t.changeType} = 'in' and ${t.quantityChange} > 0) or (${t.changeType} = 'out' and ${t.quantityChange} < 0) or ${t.changeType} = 'adjustment'`,
    ),
  ],
);
export const auditLogs = sqliteTable(
  "audit_logs",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    details: text("details", { mode: "json" }).$type<Json>().notNull(),
    createdAt: created(),
  },
  (t) => [
    index("audit_user_created_idx").on(t.userId, t.createdAt),
    index("audit_entity_idx").on(t.entityType, t.entityId),
    index("audit_created_idx").on(t.createdAt),
  ],
);
// Operational tables are intentionally separate from domain/audit tables.
export const storeSettings = sqliteTable("store_settings", {
  id: text("id").primaryKey(),
  value: text("value", { mode: "json" }).$type<StoreSettings>().notNull(),
  updatedAt: updated(),
});
export const botConversations = sqliteTable(
  "bot_conversations",
  {
    key: text("key").primaryKey(),
    value: text("value", { mode: "json" }).$type<unknown>().notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (t) => [index("conversations_expiry_idx").on(t.expiresAt)],
);
export const chatLocks = sqliteTable(
  "chat_locks",
  {
    key: text("key").primaryKey(),
    owner: text("owner").notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (t) => [index("chat_locks_expiry_idx").on(t.expiresAt)],
);
export const processedUpdates = sqliteTable(
  "processed_updates",
  { updateId: integer("update_id").primaryKey(), processedAt: integer("processed_at").notNull() },
  (t) => [index("processed_updates_created_idx").on(t.processedAt)],
);
export const mutationKeys = sqliteTable("mutation_keys", {
  key: text("key").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  result: text("result", { mode: "json" }).$type<Json>().notNull(),
  createdAt: created(),
});

export const usersRelations = relations(users, ({ many }) => ({
  orders: many(orders),
  auditLogs: many(auditLogs),
  inventoryLogs: many(inventoryLogs),
  shipmentsCreated: many(shipments, { relationName: "shipmentCreator" }),
  shipmentsUpdated: many(shipments, { relationName: "shipmentUpdater" }),
}));
export const categoryRelations = relations(categories, ({ one, many }) => ({
  parent: one(categories, {
    fields: [categories.parentId],
    references: [categories.id],
    relationName: "categoryTree",
  }),
  children: many(categories, { relationName: "categoryTree" }),
  products: many(products),
}));
export const productRelations = relations(products, ({ one, many }) => ({
  category: one(categories, { fields: [products.categoryId], references: [categories.id] }),
  orderItems: many(orderItems),
  inventoryLogs: many(inventoryLogs),
}));
export const orderRelations = relations(orders, ({ one, many }) => ({
  customer: one(users, { fields: [orders.customerTelegramId], references: [users.telegramId] }),
  items: many(orderItems),
  reference: one(orderReferences, { fields: [orders.id], references: [orderReferences.orderId] }),
  shipments: many(shipments),
}));
export const orderItemRelations = relations(orderItems, ({ one }) => ({
  order: one(orders, { fields: [orderItems.orderId], references: [orders.id] }),
  product: one(products, { fields: [orderItems.productId], references: [products.id] }),
}));
export const auditRelations = relations(auditLogs, ({ one }) => ({
  user: one(users, { fields: [auditLogs.userId], references: [users.id] }),
}));
export const inventoryRelations = relations(inventoryLogs, ({ one }) => ({
  product: one(products, { fields: [inventoryLogs.productId], references: [products.id] }),
  user: one(users, { fields: [inventoryLogs.userId], references: [users.id] }),
}));
export type User = typeof users.$inferSelect;
export type Product = typeof products.$inferSelect;

export const orderReferenceRelations = relations(orderReferences, ({ one }) => ({
  order: one(orders, { fields: [orderReferences.orderId], references: [orders.id] }),
}));
export const shipmentRelations = relations(shipments, ({ one }) => ({
  order: one(orders, { fields: [shipments.orderId], references: [orders.id] }),
  creator: one(users, {
    fields: [shipments.createdBy],
    references: [users.id],
    relationName: "shipmentCreator",
  }),
  updater: one(users, {
    fields: [shipments.updatedBy],
    references: [users.id],
    relationName: "shipmentUpdater",
  }),
}));
export type Shipment = typeof shipments.$inferSelect;

export const shipmentSequenceRelations = relations(shipmentSequences, ({ one }) => ({
  order: one(orders, { fields: [shipmentSequences.orderId], references: [orders.id] }),
}));
