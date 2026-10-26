import type { NextConfig } from "next";

const config: NextConfig = {
  poweredByHeader: false,
  serverExternalPackages: ["@libsql/client", "libsql"],
  // Relevant only to local dev through a tunnel, not to production CORS.
  allowedDevOrigins: ["*.e2b.app", "*.ngrok-free.app", "*.loca.lt"],
};
export default config;
