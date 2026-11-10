import type { Plugin } from "obsidian";
import { Platform } from "obsidian";

// Bundled require wrappers stay lazy: mobile must never evaluate desktop Node imports.
const implementation = (Platform.isDesktopApp ? require("./main") : require("./mobile")) as { default: typeof Plugin };
export default implementation.default;
