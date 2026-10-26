import type { Role } from "@/types/domain";
import { DomainError } from "./errors";

export const permissions = [
  "products:read",
  "products:write",
  "inventory:write",
  "orders:read",
  "orders:create",
  "orders:status",
  "orders:payment",
  "orders:shipping",
  "orders:shipping:correct",
  "orders:export",
  "reports:read",
  "users:manage",
  "settings:manage",
] as const;
export type Permission = (typeof permissions)[number];
const grants: Record<Role, readonly Permission[]> = {
  super_admin: permissions,
  admin: [
    "products:read",
    "products:write",
    "inventory:write",
    "orders:read",
    "orders:create",
    "orders:status",
    "orders:payment",
    "orders:shipping",
    "orders:shipping:correct",
    "orders:export",
    "reports:read",
  ],
  operator: ["orders:read", "orders:status", "orders:shipping"],
  viewer: ["products:read", "reports:read"],
};
export function can(role: Role, permission: Permission): boolean {
  return grants[role].includes(permission);
}
export function authorize(role: Role, permission: Permission): void {
  if (!can(role, permission))
    throw new DomainError("FORBIDDEN", "⛔ شما اجازهٔ دسترسی به این بخش را ندارید.");
}
export function callbackPermission(data: string): Permission | undefined {
  const [section, action] = data.split(":");
  if (section === "w") {
    const scenes: Record<string, Permission> = {
      pa: "products:write",
      pe: "products:write",
      st: "inventory:write",
      oc: "orders:create",
      um: "users:manage",
      se: "settings:manage",
      ca: "products:write",
      ps: "products:read",
      os: "orders:read",
      sm: "orders:shipping",
    };
    return scenes[action ?? ""];
  }
  if (section === "p")
    return ["add", "edit", "archive", "archiveYes", "categories", "categoryAdd"].includes(
      action ?? "",
    )
      ? "products:write"
      : action === "stock"
        ? "inventory:write"
        : "products:read";
  if (section === "o")
    return action === "new"
      ? "orders:create"
      : ["status", "change", "set"].includes(action ?? "")
        ? "orders:status"
        : ["pay", "payYes", "refund", "refundYes"].includes(action ?? "")
          ? "orders:payment"
          : "orders:read";
  if (section === "exp") return "orders:export";
  if (section === "sh")
    return ["view", "history", "parcel"].includes(action ?? "") ? "orders:read" : "orders:shipping";
  if (section === "r") return "reports:read";
  if (section === "u" || section === "a") return "users:manage";
  if (section === "s") return "settings:manage";
  return undefined;
}
