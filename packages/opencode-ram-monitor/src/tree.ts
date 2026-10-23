import { getProcessDisplayLabel } from "./command.js";
import { formatBytes, formatTreeSize } from "./format.js";
import {
  type ChildrenByParent,
  childrenByParent,
  type Inspection,
  measureRam,
  tuiBoundary,
} from "./measure.js";
import type { ProcessEntry } from "./snapshot.js";

function renderBranch(
  node: ProcessEntry,
  children: ChildrenByParent,
  skip: ReadonlySet<number>,
  prefix: string,
  isLast: boolean,
  ancestors: ReadonlySet<number>,
): { text: string; total: number } {
  const connector = isLast ? "└──" : "├──";
  const label = `${prefix}${connector} [${getProcessDisplayLabel(node.command)}] (PID ${node.pid})`;
  if (ancestors.has(node.pid)) return { text: `${label} - cycle detected\n`, total: 0 };

  const nextAncestors = new Set(ancestors).add(node.pid);
  const visible = (children.get(node.pid) ?? []).filter((child) => !skip.has(child.pid));
  let text = `${label} - ${formatTreeSize(node.rss)}\n`;
  let total = node.rss;
  visible.forEach((child, index) => {
    const branch = renderBranch(
      child,
      children,
      skip,
      prefix + (isLast ? "    " : "│   "),
      index === visible.length - 1,
      nextAncestors,
    );
    text += branch.text;
    total += branch.total;
  });
  return { text, total };
}

function renderSection(
  title: string,
  rootPid: number,
  inspection: Inspection,
  children: ChildrenByParent,
  skip: ReadonlySet<number>,
  fallbackRss: number,
): string {
  const root = inspection.entries.find((item) => item.pid === rootPid);
  if (!root) return `**${title}** (PID ${rootPid}) - ${formatBytes(fallbackRss)}`;
  const branch = renderBranch(root, children, skip, "", true, new Set());
  return `**${title}** (PID ${rootPid}) - ${formatBytes(branch.total)}\n\`\`\`text\n${branch.text}\`\`\``;
}

export function renderProcessTree(
  inspection: Inspection,
  fallbackTuiRss: number,
  warnings: readonly string[] = [],
): string {
  const { layout } = inspection;
  const ram = measureRam(inspection.entries, layout, fallbackTuiRss);
  const children = childrenByParent(inspection.entries);

  const sections = [
    "### OpenCode RAM Usage",
    `Total ${formatBytes(ram.total)} · OpenCode ${formatBytes(ram.opencode)} · Tools ${formatBytes(ram.tools)}`,
  ];
  const notes = [inspection.notice, ...warnings].filter((note): note is string => Boolean(note));
  if (notes.length > 0) sections.push(notes.map((note) => `> ${note}`).join("\n>\n"));
  sections.push(
    renderSection(
      "TUI",
      layout.tuiPid,
      inspection,
      children,
      tuiBoundary(inspection.entries, layout),
      fallbackTuiRss,
    ),
  );
  const tuiBranch = new Set([layout.tuiPid]);
  if (layout.serverPid !== null) {
    sections.push(renderSection("Server", layout.serverPid, inspection, children, tuiBranch, 0));
  }
  for (const daemon of layout.terminalPids) {
    sections.push(renderSection("Terminals", daemon, inspection, children, tuiBranch, 0));
  }
  return sections.join("\n\n");
}
