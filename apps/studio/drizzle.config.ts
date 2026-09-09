import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/bun/db/schema.ts",
  out: "./src/bun/db/migrations",
});
