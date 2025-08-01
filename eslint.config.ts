import { Linter } from "eslint";

const config: Linter.Config = {
  root: true,
  parser: "@typescript-eslint/parser",
  parserOptions: {
    ecmaVersion: "latest",
    sourceType: "module",
    project: "./tsconfig.json",
  },
  plugins: ["@typescript-eslint", "prettier"],
  extends: [
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended",
    "plugin:prettier/recommended"
  ],
  rules: {
    "@typescript-eslint/no-explicit-any": "error",
    "@typescript-eslint/explicit-function-return-type": ["error", { allowExpressions: true }],
    "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    "no-unused-vars": "off",
    "no-useless-escape": "error",
    "no-control-regex": "error"
  },
  ignorePatterns: ["dist/", "node_modules/", "*.js"],
  overrides: [
    {
      files: ["src/server.ts"],
      rules: {
        // Allow 'any' in src/server.ts for legacy/interop reasons
        "@typescript-eslint/no-explicit-any": "off"
      }
    }
  ]
};

export default config;