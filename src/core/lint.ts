import { detectFlavor, listOperations } from "./parse.js";

export interface LintIssue {
  level: "error" | "warning" | "info";
  rule: string;
  operation?: string;
  message: string;
}

/** Documentation-quality checks on a raw (non-dereferenced) spec. Cheap and side-effect free. */
export function lintSpec(doc: Record<string, any>): LintIssue[] {
  const issues: LintIssue[] = [];
  const flavor = detectFlavor(doc);
  if (!doc.info?.description) issues.push({ level: "info", rule: "info-description", message: "The API has no top-level description." });
  if (flavor.startsWith("openapi") && (!Array.isArray(doc.servers) || !doc.servers.length)) {
    issues.push({ level: "info", rule: "no-servers", message: "No servers are defined, so readers cannot see the base URL." });
  }

  const definedTags = new Set((doc.tags ?? []).map((t: any) => t?.name));
  const opIds = new Map<string, string>();
  const undefinedTags = new Set<string>();

  for (const { path, method, op, pathItem } of listOperations(doc)) {
    const label = `${method.toUpperCase()} ${path}`;
    if (!op.operationId) {
      issues.push({ level: "warning", rule: "operation-id", operation: label, message: "Missing operationId (needed for stable links and SDK generation)." });
    } else if (opIds.has(op.operationId)) {
      issues.push({ level: "error", rule: "duplicate-operation-id", operation: label, message: `operationId "${op.operationId}" is also used by ${opIds.get(op.operationId)}.` });
    } else {
      opIds.set(op.operationId, label);
    }
    if (!op.summary && !op.description) {
      issues.push({ level: "info", rule: "operation-summary", operation: label, message: "Operation has no summary or description." });
    }
    const codes = Object.keys(op.responses ?? {});
    if (!codes.some((c) => /^2|^3|^default$/i.test(c))) {
      issues.push({ level: "warning", rule: "success-response", operation: label, message: "No success (2xx/3xx) or default response is documented." });
    }
    const templated = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
    const declared = new Set(
      [...(pathItem.parameters ?? []), ...(op.parameters ?? [])]
        .filter((p: any) => p?.in === "path")
        .map((p: any) => p.name),
    );
    // Parameters that are $refs cannot be checked without dereferencing; skip when any ref is present.
    const hasRefs = [...(pathItem.parameters ?? []), ...(op.parameters ?? [])].some((p: any) => p?.$ref);
    if (!hasRefs) {
      for (const name of templated) {
        if (!declared.has(name)) {
          issues.push({ level: "error", rule: "path-parameter-declared", operation: label, message: `Path parameter {${name}} is not declared.` });
        }
      }
    }
    for (const t of op.tags ?? []) if (definedTags.size && !definedTags.has(t)) undefinedTags.add(t);
  }
  for (const t of undefinedTags) {
    issues.push({ level: "info", rule: "tag-defined", message: `Tag "${t}" is used but not described in the top-level tags list.` });
  }
  const order = { error: 0, warning: 1, info: 2 };
  return issues.sort((a, b) => order[a.level] - order[b.level]);
}
