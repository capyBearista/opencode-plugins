import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const packageRoot = join(import.meta.dirname, "..");
const sourcePath = join(packageRoot, "src", "schemas", "review-output.schema.json");
const builtPath = join(packageRoot, "dist", "schemas", "review-output.schema.json");

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`schema asset check failed: ${path} is not valid JSON: ${message}`);
  }
}

if (!existsSync(builtPath)) {
  throw new Error(
    `schema asset check failed: ${builtPath} is missing. tsc must emit the schema into dist; keep resolveJsonModule enabled and keep the import in src/index.ts.`,
  );
}

const source = readJson(sourcePath);
const built = readJson(builtPath);
if (JSON.stringify(source) !== JSON.stringify(built)) {
  throw new Error(
    `schema asset check failed: ${builtPath} does not match ${sourcePath}. Rebuild so the published validator schema matches source.`,
  );
}

process.stdout.write("schema asset check: dist/schemas/review-output.schema.json matches source\n");
