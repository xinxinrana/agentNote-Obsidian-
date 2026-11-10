import obsidianmd from "eslint-plugin-obsidianmd";
import tseslint from "typescript-eslint";

// Review-focused checks. Desktop Node modules are lazy-loaded behind src/entry.ts;
// the mobile entry test verifies they are never evaluated on mobile.
export default [{
  files: ["src/**/*.ts"],
  languageOptions: { parser: tseslint.parser, parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
  plugins: { obsidianmd, "@typescript-eslint": tseslint.plugin },
  rules: {
    "obsidianmd/no-static-styles-assignment": "error",
    "obsidianmd/prefer-create-el": "warn",
    "obsidianmd/prefer-window-timers": "warn",
    "obsidianmd/no-nodejs-modules": "warn",
    "@typescript-eslint/no-unsafe-member-access": "warn",
    "@typescript-eslint/no-unsafe-assignment": "warn",
    "@typescript-eslint/no-unsafe-argument": "warn",
    "@typescript-eslint/no-unsafe-call": "warn",
    "@typescript-eslint/no-unnecessary-type-assertion": "warn",
    "@typescript-eslint/prefer-promise-reject-errors": "warn",
    "no-control-regex": "warn",
  },
}];
