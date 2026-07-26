import { config as loadDotenv } from "dotenv";
import type { GatewayConfig } from "./types.js";

loadDotenv();

export function loadConfig(): GatewayConfig {
  const url =
    process.env.PICKLESHELL_GATEWAY_URL ||
    process.env.LOCALAGENT_GATEWAY_URL;
  const api_key =
    process.env.PICKLESHELL_API_KEY ||
    process.env.LOCALAGENT_API_KEY;

  if (!url || !api_key) {
    throw new Error(
      "Missing required env vars: PICKLESHELL_GATEWAY_URL, PICKLESHELL_API_KEY"
    );
  }

  return {
    url: url.replace(/\/$/, ""),
    api_key,
    timeout_ms: parseInt(
      process.env.PICKLESHELL_TIMEOUT_MS ||
      process.env.LOCALAGENT_TIMEOUT_MS ||
      "420000",
      10
    ),
  };
}
