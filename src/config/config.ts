import { type Env, envSchema } from "./env";

let config: Env | undefined;

export function loadConfig(): Env {
  config = envSchema.parse(process.env);
  return config;
}

export function getConfig(): Env {
  if (!config) throw new Error("Config not loaded. Call loadConfig() first.");
  return config;
}
