export function GET(): Response {
  return Response.json({ status: "ok", service: "telegram-warehouse-bot" });
}
