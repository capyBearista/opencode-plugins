const owner = process.env.OPENCODE_UPSTREAM_OWNER ?? "anomalyco";
const repo = process.env.OPENCODE_UPSTREAM_REPO ?? "opencode";
const ref = process.env.OPENCODE_UPSTREAM_REF ?? "dev";

const upstreamBase = `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/packages/opencode/src/session/prompt`;
const targetDir = `${process.cwd()}/src/prompt`;

const allowedFiles = [
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

await Bun.$`mkdir -p ${targetDir}`;

await Promise.all(
  allowedFiles.map(async (file) => {
    const response = await fetch(`${upstreamBase}/${file}`);
    if (!response.ok) {
      throw new Error(`Failed to fetch ${file}: ${response.status} ${response.statusText}`);
    }

    await Bun.write(`${targetDir}/${file}`, await response.text());
  }),
);

export {};
