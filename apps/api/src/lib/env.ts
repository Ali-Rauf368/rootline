import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().default(4100),
  DATABASE_URL: z.string().default("postgresql://rootline@127.0.0.1:55434/rootline"),
  REDIS_URL: z.string().optional().transform((v) => v || undefined),
  JWT_SECRET: z.string().min(16).default("dev-only-secret-change-me-please"),
  WEB_ORIGIN: z.string().default("http://localhost:3100"),
  /** Shared token for machine ingestion if no per-source API key is used */
  INGEST_TOKEN: z.string().default("rl_dev_ingest_token"),
  GITHUB_WEBHOOK_SECRET: z.string().optional(),
  GITHUB_TOKEN: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default("claude-opus-5-5"),
  AGENT_MODE: z.enum(["auto", "claude", "heuristic"]).default("auto"),
  AGENT_MAX_STEPS: z.coerce.number().int().min(3).max(40).default(16),
  /** Optional: cost findings are explained by Gemini; without a key the built-in rules are used */
  GEMINI_API_KEY: z.string().optional().transform((v) => v || undefined),
  GEMINI_MODEL: z.string().default("gemini-flash-latest"),
  SIMULATOR: z.enum(["on", "off"]).default("on"),
  LOG_LEVEL: z.string().default("info"),
});

export const env = schema.parse(process.env);
if (env.NODE_ENV === "production" && env.JWT_SECRET.startsWith("dev-only")) throw new Error("Set JWT_SECRET in production");
export const isTest = env.NODE_ENV === "test";
