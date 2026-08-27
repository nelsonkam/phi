import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import tailwind from "bun-plugin-tailwind";

import { RELEASE_TARGETS, VERSION } from "../src/version.ts";

const root = resolve(import.meta.dir, "..");
const outDir = resolve(root, "dist", "release");
const cliPath = resolve(root, "src", "cli.ts");
const workerPath = resolve(root, "src", "core", "search", "vector-worker.ts");
const workerJs = resolve(outDir, "vector-worker.js");
const onnxBindingMarker =
  "require(`../bin/napi-v3/${process.platform}/${process.arch}/onnxruntime_binding.node`)";

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const onnxNativeLoader: Bun.BunPlugin = {
  name: "phi-onnx-native-loader",
  setup(build) {
    build.onLoad({ filter: /node_modules\/onnxruntime-node\/dist\/binding\.js$/ }, async ({ path }) => {
      const source = await Bun.file(path).text();
      if (!source.includes(onnxBindingMarker)) {
        throw new Error(`Could not patch onnxruntime-node's native loader in ${path}`);
      }
      return {
        contents: source.replace(
          onnxBindingMarker,
          "require((process.env[\"PHI_ONNX_NATIVE_DIR\"] || \"\") + \"/onnxruntime_binding.node\")",
        ),
        loader: "js",
      };
    });
  },
};

const sharpStub: Bun.BunPlugin = {
  name: "phi-sharp-stub",
  setup(build) {
    build.onResolve({ filter: /^sharp$/ }, () => ({
      path: "sharp",
      namespace: "phi-sharp-stub",
    }));
    build.onLoad({ filter: /.*/, namespace: "phi-sharp-stub" }, () => ({
      contents: "export default {};\n",
      loader: "js",
    }));
  },
};

function nativeFilesForTarget(target: string): { binding: string; dylib: string } {
  const arch = target === "bun-darwin-arm64" ? "arm64" : "x64";
  const directory = resolve(
    root,
    "node_modules",
    "onnxruntime-node",
    "bin",
    "napi-v3",
    "darwin",
    arch,
  );
  const binding = resolve(directory, "onnxruntime_binding.node");
  const dylib = resolve(directory, "libonnxruntime.1.21.0.dylib");
  if (!existsSync(binding) || !existsSync(dylib)) {
    throw new Error(`Missing onnxruntime-node native files for ${target} in ${directory}`);
  }
  return { binding, dylib };
}

function releaseEntrySource(binding: string, dylib: string, worker: string): string {
  return (
    `import nativeBinding from ${JSON.stringify(binding)} with { type: "file" };\n` +
    `import nativeDylib from ${JSON.stringify(dylib)} with { type: "file" };\n` +
    `import vectorWorker from ${JSON.stringify(worker)} with { type: "file" };\n` +
    `import { mkdtempSync, rmSync } from "node:fs";\n` +
    `import { tmpdir } from "node:os";\n` +
    `import { join } from "node:path";\n` +
    `const nativeDir = mkdtempSync(join(tmpdir(), "phi-onnx-"));\n` +
    `process.once("exit", () => {\n` +
    `  rmSync(nativeDir, { recursive: true, force: true });\n` +
    `});\n` +
    `await Bun.write(join(nativeDir, "onnxruntime_binding.node"), Bun.file(nativeBinding));\n` +
    `await Bun.write(join(nativeDir, "libonnxruntime.1.21.0.dylib"), Bun.file(nativeDylib));\n` +
    `await Bun.write(join(nativeDir, "vector-worker.js"), Bun.file(vectorWorker));\n` +
    `process.env.PHI_ONNX_NATIVE_DIR = nativeDir;\n` +
    `process.env.PHI_VECTOR_WORKER_URL = join(nativeDir, "vector-worker.js");\n` +
    `process.env.NODE_ENV = "production";\n` +
    `if (process.env.PHI_ONNX_PROBE === "1") {\n` +
    `  await import("onnxruntime-node");\n` +
    `  console.log("onnxruntime-node native binding loaded");\n` +
    `  process.exit(0);\n` +
    `}\n` +
    `const { runCli } = await import(${JSON.stringify(cliPath)});\n` +
    `process.exitCode = await runCli(Bun.argv.slice(2));\n`
  );
}

const requested = process.argv.slice(2);
type ReleaseTarget = (typeof RELEASE_TARGETS)[number];
const known = new Map<string, ReleaseTarget>(RELEASE_TARGETS.flatMap((entry) => [
  [entry.target, entry],
  [entry.asset, entry],
] as const));
const targets = requested.length > 0
  ? [...new Set(requested.map((name) => known.get(name)))].filter(
      (entry): entry is ReleaseTarget => Boolean(entry),
    )
  : [...RELEASE_TARGETS];

if (targets.length === 0 || requested.some((name) => !known.has(name))) {
  console.error(
    `Unknown target in [${requested.join(", ")}]. Known targets: ${RELEASE_TARGETS.map((entry) => entry.target).join(", ")}`,
  );
  process.exit(2);
}

const workerBundle = await Bun.build({
  entrypoints: [workerPath],
  outdir: outDir,
  naming: "[name].js",
  target: "bun",
  minify: false,
  env: "disable",
  plugins: [onnxNativeLoader, sharpStub],
});
if (!workerBundle.success || !existsSync(workerJs)) {
  for (const log of workerBundle.logs) console.error(log);
  throw new Error("Failed to bundle vector-worker.ts for the release binary");
}

console.log(`Building phi v${VERSION} for ${targets.length} target(s)...`);
for (const { target, asset } of targets) {
  const outfile = resolve(outDir, asset);
  const { binding, dylib } = nativeFilesForTarget(target);
  const entrypoint = resolve(outDir, `.entry-${target}.ts`);
  writeFileSync(entrypoint, releaseEntrySource(binding, dylib, workerJs));
  let result: Awaited<ReturnType<typeof Bun.build>>;
  try {
    result = await Bun.build({
      entrypoints: [entrypoint],
      compile: { target: target as Bun.Build.CompileTarget, outfile },
      minify: true,
      sourcemap: "linked",
      plugins: [tailwind, onnxNativeLoader],
      naming: { asset: "[name].[ext]" },
    });
  } finally {
    rmSync(entrypoint, { force: true });
  }
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error(`Build failed for ${target}`);
  }

  if (process.platform === "darwin") {
    const remove = Bun.spawnSync(["codesign", "--remove-signature", outfile]);
    if (remove.exitCode !== 0) {
      throw new Error(`Could not remove Bun's embedded signature from ${asset}`);
    }
    const sign = Bun.spawnSync(["codesign", "--sign", "-", "--force", outfile]);
    if (sign.exitCode !== 0) throw new Error(`Could not ad-hoc sign ${asset}`);
  }
  console.log(`  ${asset}`);
}
rmSync(workerJs, { force: true });
console.log(`Done. Binaries are in ${outDir}`);
