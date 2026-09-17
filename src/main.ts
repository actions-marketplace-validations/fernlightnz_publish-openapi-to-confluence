import { appendFileSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { confluenceClient } from "./confluence.js";
import { parseFailOn, parseMode, run } from "./run.js";

/** GitHub Actions entry point. Reads INPUT_* env vars and writes outputs and the step summary without @actions/core. */

const input = (name: string, required = false): string => {
  const v = (process.env[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`] ?? "").trim();
  if (required && !v) throw new Error(`Input "${name}" is required.`);
  return v;
};

function setOutput(name: string, value: string | number | boolean) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  const delim = `ghadelim_${randomUUID()}`;
  appendFileSync(file, `${name}<<${delim}\n${value}\n${delim}\n`);
}

async function main() {
  const token = input("api-token", true);
  console.log(`::add-mask::${token}`);
  const specPath = input("spec", true);
  const siteUrl = input("confluence-url", true);
  const pageId = input("page-id", true);
  if (!/^\d+$/.test(pageId)) throw new Error(`page-id must be the numeric page ID, got "${pageId}".`);
  if (!/^https:\/\/|^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(siteUrl)) throw new Error(`confluence-url must start with https://, got "${siteUrl}".`);

  let specText: string;
  try {
    specText = readFileSync(specPath, "utf8");
  } catch {
    throw new Error(`Spec file not found: ${specPath}`);
  }

  const repo = process.env.GITHUB_REPOSITORY;
  const sha = process.env.GITHUB_SHA?.slice(0, 7);
  const comment = input("comment") || (repo && sha ? `Published from ${repo}@${sha}` : "Published by GitHub Actions");

  const result = await run(
    {
      specPath,
      specText,
      pageId,
      mode: parseMode(input("mode")),
      attachmentName: input("attachment-name"),
      failOn: parseFailOn(input("fail-on")),
      comment,
      pageUrl: `${siteUrl.replace(/\/+$/, "").replace(/\/wiki$/, "")}/wiki/pages/viewpage.action?pageId=${pageId}`,
    },
    confluenceClient(siteUrl, input("email", true), token),
  );

  console.log(result.report);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, result.report);
  setOutput("breaking", result.summary.breaking);
  setOutput("warnings", result.summary.warning);
  setOutput("info", result.summary.info);
  setOutput("published", result.published);
  setOutput("attachment-version", result.attachmentVersion ?? "");
  setOutput("report", result.report);
  if (!result.ok) {
    console.log(`::error::${result.failureReason}`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.log(`::error::${(e as Error).message}`);
  process.exitCode = 1;
});
