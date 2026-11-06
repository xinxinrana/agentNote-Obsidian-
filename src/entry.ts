import { Platform } from "obsidian";

// Bundled require wrappers stay lazy: mobile must never evaluate desktop Node imports.
const implementation = Platform.isDesktopApp ? require("./main") : require("./mobile");
export default implementation.default;
