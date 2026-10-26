export const roles = ["super_admin", "admin", "operator", "viewer"] as const;
export type Role = (typeof roles)[number];
export const orderStatuses = [
  "pending",
  "confirmed",
  "processing",
  "shipped",
  "delivered",
  "cancelled",
] as const;
export type OrderStatus = (typeof orderStatuses)[number];
export const paymentStatuses = ["unpaid", "paid", "refunded"] as const;
export type PaymentStatus = (typeof paymentStatuses)[number];
export const inventoryChangeTypes = ["in", "out", "adjustment"] as const;
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface Lease {
  key: string;
  owner: string;
}
export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pages: number;
  pageSize: number;
}
export const PAGE_SIZE = 6;
export const MAX_STOCK = 1_000_000;
export const MAX_PRICE = 1_000_000_000_000;
export const MAX_MONEY = Number.MAX_SAFE_INTEGER;

export const carriers = ["iran_post", "tipax", "chapar", "courier", "pickup", "other"] as const;
export type Carrier = (typeof carriers)[number];
export const orderListFilters = ["all", "ready", "shipped", "untracked"] as const;
export type OrderListFilter = (typeof orderListFilters)[number];

export const shipmentStates = ["draft", "dispatched", "delivered"] as const;
export type ShipmentState = (typeof shipmentStates)[number];
export const MAX_SHIPMENTS_PER_ORDER = 20;
export const MAX_EXPORT_ROWS = 1000;
export const exportPeriods = ["all", "day", "month"] as const;
export type ExportPeriod = (typeof exportPeriods)[number];
