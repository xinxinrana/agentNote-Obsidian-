import esbuild from "esbuild";

await esbuild.build({
  entryPoints: ["test/pet-preview.ts"],
  bundle: true,
  format: "iife",
  target: "es2022",
  loader: { ".svg": "dataurl" },
  outfile: "dist/pet-preview.js",
});

console.log("Open test/pet-preview.html to review the animated character.");
