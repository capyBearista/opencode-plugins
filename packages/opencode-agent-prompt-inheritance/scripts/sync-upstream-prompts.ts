const owner = process.env.OPENCODE_UPSTREAM_OWNER ?? "anomalyco";
const repo = process.env.OPENCODE_UPSTREAM_REPO ?? "opencode";
const ref = process.env.OPENCODE_UPSTREAM_REF ?? "dev";

export const ALLOWED_FILES = [
  "anthropic.txt",
  "beast.txt",
  "codex.txt",
  "copilot-gpt-5.txt",
  "default.txt",
  "gemini.txt",
  "gpt.txt",
  "kimi.txt",
  "trinity.txt",
] as const;

export function buildUpstreamUrl(owner: string, repo: string, ref: string, file: string) {
  return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/packages/opencode/src/session/prompt/${file}`;
}

export async function syncPrompts(
  targetDir: string,
  files: readonly string[],
  upstreamBase: string,
) {
  await Bun.$`mkdir -p ${targetDir}`;

  await Promise.all(
    files.map(async (file) => {
      const response = await fetch(`${upstreamBase}/${file}`);
      if (!response.ok) {
        throw new Error(`Failed to fetch ${file}: ${response.status} ${response.statusText}`);
      }

      await Bun.write(`${targetDir}/${file}`, await response.text());
    }),
  );
}

if (import.meta.path === Bun.main) {
  const upstreamBase = buildUpstreamUrl(owner, repo, ref, "");
  const targetDir = `${process.cwd()}/src/prompt`;
  await syncPrompts(targetDir, ALLOWED_FILES, upstreamBase.slice(0, -1));
}
