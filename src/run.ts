import { basename } from "node:path";
import { diffSpecs, loadSpec, type Change, type DiffReport } from "./core/index.js";
import type { AttachmentStore } from "./confluence.js";

export type Mode = "publish" | "check";
export type FailOn = "breaking" | "warning" | "none";

export interface RunInputs {
  specPath: string;
  specText: string;
  pageId: string;
  mode: Mode;
  attachmentName?: string;
  failOn: FailOn;
  comment: string;
  pageUrl?: string;
}

export interface RunResult {
  ok: boolean;
  failureReason?: string;
  published: boolean;
  attachmentVersion?: number;
  summary: DiffReport["summary"];
  report: string;
}

export function parseMode(v: string | undefined): Mode {
  const m = (v || "publish").trim().toLowerCase();
  if (m !== "publish" && m !== "check") throw new Error(`Invalid mode "${v}". Use "publish" or "check".`);
  return m;
}

export function parseFailOn(v: string | undefined): FailOn {
  const m = (v || "breaking").trim().toLowerCase();
  if (m !== "breaking" && m !== "warning" && m !== "none") throw new Error(`Invalid fail-on "${v}". Use "breaking", "warning" or "none".`);
  return m;
}

export async function run(inputs: RunInputs, store: AttachmentStore): Promise<RunResult> {
  const fileName = inputs.attachmentName?.trim() || basename(inputs.specPath);
  const next = await loadSpec(inputs.specText);
  if (next.flavor === "unknown" || !next.dereferenced) {
    const report = `### ❌ ${fileName} is not a usable OpenAPI spec\n\n${next.errors.map((e) => `- ${e}`).join("\n")}\n`;
    return { ok: false, failureReason: next.errors[0] ?? "Invalid spec.", published: false, summary: { breaking: 0, warning: 0, info: 0 }, report };
  }

  const existing = await store.find(inputs.pageId, fileName);
  let diff: DiffReport = { changes: [], summary: { breaking: 0, warning: 0, info: 0 } };
  let baseline: string | null = null;
  let prevText: string | null = null;
  if (existing) {
    prevText = await store.download(existing);
    // A corrupt or non-OpenAPI published file just means there is no baseline to compare against.
    const prev = await loadSpec(prevText).catch(() => null);
    if (prev?.dereferenced) {
      diff = diffSpecs(prev.dereferenced, next.dereferenced);
      baseline = `${fileName} v${existing.version}${prev.version ? ` (API ${prev.version})` : ""}`;
    }
  }

  const blocking =
    inputs.failOn === "breaking" ? diff.summary.breaking :
    inputs.failOn === "warning" ? diff.summary.breaking + diff.summary.warning : 0;

  let published = false;
  let attachmentVersion = existing?.version;
  const unchanged = prevText !== null && prevText.trim() === inputs.specText.trim();
  if (inputs.mode === "publish" && blocking === 0 && !unchanged) {
    const att = await store.upload(inputs.pageId, fileName, inputs.specText, inputs.comment);
    published = true;
    attachmentVersion = att.version;
  }

  const report = renderReport({ fileName, title: next.title, apiVersion: next.version, baseline, diff, inputs, published, attachmentVersion, blocking, unchanged, warnings: next.errors });
  return {
    ok: blocking === 0,
    failureReason: blocking ? `${blocking} ${inputs.failOn === "warning" ? "breaking change(s) or warning(s)" : "breaking change(s)"} compared with the published spec.` : undefined,
    published,
    attachmentVersion,
    summary: diff.summary,
    report,
  };
}

const ICON: Record<Change["severity"], string> = { breaking: "🔴 Breaking", warning: "🟠 Warning", info: "🔵 Info" };

function renderReport(r: {
  fileName: string; title: string; apiVersion: string; baseline: string | null; diff: DiffReport; inputs: RunInputs;
  published: boolean; attachmentVersion?: number; blocking: number; unchanged: boolean; warnings: string[];
}): string {
  const { diff } = r;
  const lines: string[] = [];
  const head = r.blocking ? "❌" : diff.summary.breaking ? "⚠️" : "✅";
  lines.push(`### ${head} ${r.title}${r.apiVersion ? ` ${r.apiVersion}` : ""}`);
  lines.push("");
  if (!r.baseline) {
    lines.push(`No published version of \`${r.fileName}\` found on the page, so there is nothing to compare.`);
  } else {
    lines.push(`Compared with **${r.baseline}**: **${diff.summary.breaking}** breaking, **${diff.summary.warning}** warnings, **${diff.summary.info}** non-breaking.`);
  }
  lines.push("");
  if (r.published) {
    lines.push(`📘 Published as \`${r.fileName}\` version ${r.attachmentVersion}${r.inputs.pageUrl ? ` on [the Confluence page](${r.inputs.pageUrl})` : ""}.`);
  } else if (r.inputs.mode === "publish" && r.unchanged) {
    lines.push("Spec is identical to the published version, so nothing was uploaded.");
  } else if (r.inputs.mode === "publish" && r.blocking) {
    lines.push(`Not published, because \`fail-on: ${r.inputs.failOn}\` blocked it.`);
  }
  const shown = diff.changes.filter((c) => c.severity !== "info");
  if (shown.length) {
    lines.push("", "| Severity | Operation | Where | Change |", "|---|---|---|---|");
    for (const c of shown) lines.push(`| ${ICON[c.severity]} | \`${esc(c.operation)}\` | ${c.location ? `\`${esc(c.location)}\`` : ""} | ${esc(c.message)} |`);
  }
  const info = diff.changes.filter((c) => c.severity === "info");
  if (info.length) {
    lines.push("", `<details><summary>${info.length} non-breaking change${info.length > 1 ? "s" : ""}</summary>`, "");
    for (const c of info) lines.push(`- \`${esc(c.operation)}\`${c.location ? ` ${esc(c.location)}` : ""}: ${esc(c.message)}`);
    lines.push("", "</details>");
  }
  if (r.warnings.length) {
    lines.push("", `<details><summary>Spec validation notes (${r.warnings.length})</summary>`, "");
    for (const w of r.warnings) lines.push(`- ${esc(w)}`);
    lines.push("", "</details>");
  }
  lines.push("", "<sub>Rendered in Confluence by [API Docs for Confluence](https://fernlight.dev) · Fernlight</sub>");
  return lines.join("\n") + "\n";
}

const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
