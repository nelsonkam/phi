// Ambient types for Bun's non-code imports. TypeScript 7 no longer
// auto-includes every node_modules/@types package (tsconfig pins
// `types: ["bun"]`), so the extensions phi uses are declared here.

// Imported `with { type: "text" }` — Bun hands back the file contents.
declare module "*.md" {
  const text: string;
  export default text;
}

// Side-effect stylesheet imports, bundled by Bun's CSS bundler.
declare module "*.css" {}
