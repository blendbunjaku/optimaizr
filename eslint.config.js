import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/node_modules/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Unused variables are usually a mistake; an underscore prefix marks the
      // deliberate ones (unused catch bindings, interface stubs).
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrors: "none",
          // Allows `const { secret, ...rest } = obj` to omit a field.
          ignoreRestSiblings: true,
        },
      ],
      // The provider SDK surfaces are genuinely untyped; `any` is allowed but
      // visible in review rather than silently normal.
      "@typescript-eslint/no-explicit-any": "warn",
      // console is how the CLI talks to the user; the API uses the logger.
      "no-console": "off",
    },
  },
  {
    // Tests are plain JS run by node:test.
    files: ["**/test/**/*.mjs", "**/scripts/**/*.mjs"],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      globals: { process: "readonly", Buffer: "readonly", console: "readonly", URL: "readonly" },
    },
  },
);
