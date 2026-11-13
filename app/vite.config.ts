import { defineConfig } from "vitest/config";

export default defineConfig({
  base: "./", // works at https://<user>.github.io/<repo>/
  build: { outDir: "dist", sourcemap: false, target: "es2022" },
  test: { environment: "node" },
});
