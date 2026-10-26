// Backend only. No React UI, admin web panel, or unauthenticated business API.
export function GET(): Response {
  return Response.json({ service: "Telegram warehouse & sales backend", health: "/api/health" });
}
