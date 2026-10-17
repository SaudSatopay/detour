import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Local tooling output (agent worktrees, evidence scripts and screenshots), never part of the app.
    ".claude/**",
    ".missile/**",
    // The product film is its own Remotion project with its own lint setup.
    "film/**",
  ]),
]);

export default eslintConfig;
