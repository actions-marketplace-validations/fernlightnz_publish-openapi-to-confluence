import { normalizeOperations, type NormOperation } from "./normalize.js";

export type Severity = "breaking" | "warning" | "info";

export interface Change {
  severity: Severity;
  code: string;
  /** "GET /users/{id}" or "servers" etc. */
  operation: string;
  /** Where inside the operation, e.g. "request body › application/json › address.zip". */
  location: string;
  message: string;
}

export interface DiffReport {
  changes: Change[];
  summary: Record<Severity, number>;
}

type Dir = "request" | "response";

export function diffSpecs(oldDoc: Record<string, any>, newDoc: Record<string, any>): DiffReport {
  const changes: Change[] = [];
  const add = (c: Change) => changes.push(c);
  const oldOps = normalizeOperations(oldDoc);
  const newOps = normalizeOperations(newDoc);

  for (const [key, o] of oldOps) {
    const n = newOps.get(key);
    const label = `${o.method.toUpperCase()} ${o.path}`;
    if (!n) {
      add({
        severity: o.deprecated ? "warning" : "breaking",
        code: o.deprecated ? "deprecated-operation-removed" : "operation-removed",
        operation: label,
        location: "",
        message: o.deprecated ? "Deprecated operation was removed." : "Operation was removed.",
      });
      continue;
    }
    diffOperation(o, n, `${n.method.toUpperCase()} ${n.path}`, add);
  }
  for (const [key, n] of newOps) {
    if (!oldOps.has(key)) {
      add({ severity: "info", code: "operation-added", operation: `${n.method.toUpperCase()} ${n.path}`, location: "", message: "New operation." });
    }
  }

  const oldServers = serverUrls(oldDoc);
  const newServers = new Set(serverUrls(newDoc));
  for (const url of oldServers) {
    if (!newServers.has(url)) {
      add({ severity: "warning", code: "server-removed", operation: "servers", location: "", message: `Server ${url} was removed.` });
    }
  }

  const order: Record<Severity, number> = { breaking: 0, warning: 1, info: 2 };
  changes.sort((a, b) => order[a.severity] - order[b.severity] || a.operation.localeCompare(b.operation));
  const summary = { breaking: 0, warning: 0, info: 0 };
  for (const c of changes) summary[c.severity]++;
  return { changes, summary };
}

function serverUrls(doc: Record<string, any>): string[] {
  if (Array.isArray(doc.servers)) return doc.servers.map((s: any) => String(s?.url ?? "")).filter(Boolean);
  if (doc.host) return (doc.schemes ?? ["https"]).map((s: string) => `${s}://${doc.host}${doc.basePath ?? ""}`);
  return [];
}

function diffOperation(o: NormOperation, n: NormOperation, op: string, add: (c: Change) => void) {
  if (!o.deprecated && n.deprecated) {
    add({ severity: "info", code: "operation-deprecated", operation: op, location: "", message: "Operation is now deprecated." });
  }
  if (o.operationId && n.operationId && o.operationId !== n.operationId) {
    add({
      severity: "warning", code: "operation-id-changed", operation: op, location: "",
      message: `operationId changed from "${o.operationId}" to "${n.operationId}" (generated SDK method names will change).`,
    });
  }

  // Parameters
  for (const [key, p] of o.params) {
    const q = n.params.get(key);
    const where = `${p.in} parameter "${p.name}"`;
    if (!q) {
      add({ severity: "warning", code: "parameter-removed", operation: op, location: where, message: "Parameter was removed; clients still sending it may be rejected." });
      continue;
    }
    if (!p.required && q.required) {
      add({ severity: "breaking", code: "parameter-became-required", operation: op, location: where, message: "Optional parameter is now required." });
    }
    compareSchema(p.schema, q.schema, "request", { op, loc: where, add });
  }
  for (const [key, q] of n.params) {
    if (o.params.has(key)) continue;
    const where = `${q.in} parameter "${q.name}"`;
    if (q.required) {
      add({ severity: "breaking", code: "required-parameter-added", operation: op, location: where, message: "New required parameter." });
    } else {
      add({ severity: "info", code: "optional-parameter-added", operation: op, location: where, message: "New optional parameter." });
    }
  }

  // Request body
  if (!o.body && n.body?.required) {
    add({ severity: "breaking", code: "required-request-body-added", operation: op, location: "request body", message: "A required request body was added." });
  } else if (o.body && !n.body) {
    add({ severity: "warning", code: "request-body-removed", operation: op, location: "request body", message: "Request body was removed." });
  } else if (o.body && n.body) {
    if (!o.body.required && n.body.required) {
      add({ severity: "breaking", code: "request-body-became-required", operation: op, location: "request body", message: "Request body is now required." });
    }
    for (const [mt, schema] of o.body.content) {
      const loc = `request body › ${mt}`;
      if (!n.body.content.has(mt)) {
        add({ severity: "breaking", code: "request-media-type-removed", operation: op, location: loc, message: `Media type ${mt} is no longer accepted.` });
      } else {
        compareSchema(schema, n.body.content.get(mt), "request", { op, loc, add });
      }
    }
  }

  // Responses
  for (const [code, media] of o.responses) {
    const loc = `response ${code}`;
    const nm = n.responses.get(code);
    if (!nm) {
      const success = /^2/.test(code);
      add({
        severity: success ? "breaking" : "warning",
        code: success ? "success-response-removed" : "response-removed",
        operation: op, location: loc, message: `Response ${code} was removed.`,
      });
      continue;
    }
    for (const [mt, schema] of media) {
      if (!nm.has(mt)) {
        add({ severity: "breaking", code: "response-media-type-removed", operation: op, location: `${loc} › ${mt}`, message: `Response no longer returns ${mt}.` });
      } else {
        compareSchema(schema, nm.get(mt), "response", { op, loc: `${loc} › ${mt}`, add });
      }
    }
  }
  for (const code of n.responses.keys()) {
    if (!o.responses.has(code) && code !== "DEFAULT") {
      add({ severity: /^2/.test(code) ? "warning" : "info", code: "response-added", operation: op, location: `response ${code}`, message: `New response ${code}; clients may need to handle it.` });
    }
  }

  // Security: breaking when some request that used to be accepted is no longer accepted.
  const oldAlts = o.security;
  const newAlts = n.security;
  if (!isAnonymous(oldAlts) || !isAnonymous(newAlts)) {
    if (isAnonymous(oldAlts) && !isAnonymous(newAlts)) {
      add({ severity: "breaking", code: "security-added", operation: op, location: "security", message: "Operation now requires authentication." });
    } else {
      for (const alt of oldAlts) {
        if (!newAlts.some((nalt) => satisfiedBy(nalt, alt))) {
          add({
            severity: "breaking", code: "security-requirement-tightened", operation: op, location: "security",
            message: `Clients authenticating with ${describeAuth(alt)} are no longer accepted.`,
          });
        }
      }
    }
  }
}

function describeAuth(alt: string[]): string {
  if (!alt.length) return "no credentials";
  return alt
    .map((req) => {
      const [scheme, scopes] = req.split(":");
      return scopes ? `${scheme} (scopes: ${scopes.split(",").join(", ")})` : scheme;
    })
    .join(" + ");
}

function isAnonymous(alts: string[][]): boolean {
  return alts.length === 0 || alts.some((a) => a.length === 0);
}

/** Does the credential set `have` (old requirement) satisfy new requirement `need`? */
function satisfiedBy(need: string[], have: string[]): boolean {
  return need.every((req) => {
    const [scheme, scopes = ""] = req.split(":");
    const needScopes = scopes ? scopes.split(",") : [];
    return have.some((h) => {
      const [hs, hscopes = ""] = h.split(":");
      const got = new Set(hscopes ? hscopes.split(",") : []);
      return hs === scheme && needScopes.every((s) => got.has(s));
    });
  });
}

// ---------------------------------------------------------------- schemas

interface Ctx {
  op: string;
  loc: string;
  /** Property path inside the schema, e.g. address.zip or items[]. */
  prop?: string;
  add: (c: Change) => void;
  seen?: WeakMap<object, WeakSet<object>>;
  depth?: number;
}

const MAX_DEPTH = 40;

function typeSet(s: any): Set<string> | null {
  if (!s || typeof s !== "object") return null;
  let t: string[] | null = null;
  if (Array.isArray(s.type)) t = [...s.type];
  else if (typeof s.type === "string") t = [s.type];
  if (!t) return null;
  if (s.nullable === true && !t.includes("null")) t.push("null");
  return new Set(t);
}

/** Merge allOf branches into one schema so properties/required compare naturally. */
function flatten(s: any): any {
  if (!s || typeof s !== "object" || !Array.isArray(s.allOf)) return s;
  const merged: any = { ...s, properties: { ...(s.properties ?? {}) }, required: [...(s.required ?? [])] };
  delete merged.allOf;
  for (const part of s.allOf) {
    const f = flatten(part);
    if (!f || typeof f !== "object") continue;
    Object.assign(merged.properties, f.properties ?? {});
    merged.required.push(...(f.required ?? []));
    if (!merged.type && f.type) merged.type = f.type;
    if (merged.nullable === undefined && f.nullable !== undefined) merged.nullable = f.nullable;
  }
  if (!Object.keys(merged.properties).length) delete merged.properties;
  if (!merged.required.length) delete merged.required;
  return merged;
}

function accepts(wider: Set<string>, narrower: Set<string>): boolean {
  for (const t of narrower) {
    if (wider.has(t)) continue;
    if (t === "integer" && wider.has("number")) continue;
    return false;
  }
  return true;
}

const fmt = (s: Set<string>) => [...s].sort().join(" | ");

export function compareSchema(oldS: any, newS: any, dir: Dir, ctx: Ctx): void {
  if (!oldS || !newS || typeof oldS !== "object" || typeof newS !== "object") return;
  const depth = ctx.depth ?? 0;
  if (depth > MAX_DEPTH) return;
  const seen = ctx.seen ?? new WeakMap();
  const pairs = seen.get(oldS) ?? new WeakSet();
  if (pairs.has(newS)) return; // cycle
  pairs.add(newS);
  seen.set(oldS, pairs);

  const o = flatten(oldS);
  const n = flatten(newS);
  const here = at(ctx.loc, ctx.prop);
  const emit = (severity: Severity, code: string, message: string) =>
    ctx.add({ severity, code: `${dir}-${code}`, operation: ctx.op, location: here, message });

  const ot = typeSet(o);
  const nt = typeSet(n);
  if (ot && nt) {
    // Requests: the new schema must accept everything the old one did.
    // Responses: the new schema must not produce anything the old one could not.
    const ok = dir === "request" ? accepts(nt, ot) : accepts(ot, nt);
    if (!ok) emit("breaking", "type-changed", `Type changed from ${fmt(ot)} to ${fmt(nt)}.`);
  }
  if (o.format && n.format && o.format !== n.format) {
    emit("breaking", "format-changed", `Format changed from "${o.format}" to "${n.format}".`);
  }

  if (Array.isArray(o.enum) && Array.isArray(n.enum)) {
    const ov = new Set(o.enum.map((v: unknown) => JSON.stringify(v)));
    const nv = new Set(n.enum.map((v: unknown) => JSON.stringify(v)));
    const removed = [...ov].filter((v) => !nv.has(v));
    const added = [...nv].filter((v) => !ov.has(v));
    if (dir === "request" && removed.length) emit("breaking", "enum-value-removed", `No longer accepts ${removed.join(", ")}.`);
    if (dir === "response" && added.length) emit("warning", "enum-value-added", `May now return ${added.join(", ")}; strict clients may fail.`);
  } else if (dir === "request" && !Array.isArray(o.enum) && Array.isArray(n.enum)) {
    emit("breaking", "enum-added", `Now restricted to ${n.enum.map((v: unknown) => JSON.stringify(v)).join(", ")}.`);
  }

  if (dir === "request") {
    const tighter = (k: string, cmp: (a: number, b: number) => boolean, word: string) => {
      const a = o[k], b = n[k];
      if (typeof b === "number" && (typeof a !== "number" || cmp(b, a))) emit("breaking", `${k}-tightened`, `${k} ${word} (${a ?? "none"} → ${b}).`);
    };
    tighter("maxLength", (b, a) => b < a, "reduced");
    tighter("maximum", (b, a) => b < a, "reduced");
    tighter("maxItems", (b, a) => b < a, "reduced");
    tighter("minLength", (b, a) => b > a, "increased");
    tighter("minimum", (b, a) => b > a, "increased");
    tighter("minItems", (b, a) => b > a, "increased");
    if (n.pattern && n.pattern !== o.pattern) emit("breaking", "pattern-changed", `Pattern changed to /${n.pattern}/.`);
  }

  // Object properties
  const oProps: Record<string, any> = o.properties ?? {};
  const nProps: Record<string, any> = n.properties ?? {};
  const oReq = new Set<string>(o.required ?? []);
  const nReq = new Set<string>(n.required ?? []);
  for (const [name, os] of Object.entries(oProps)) {
    const prop = ctx.prop ? `${ctx.prop}.${name}` : name;
    const loc = at(ctx.loc, prop);
    const ns = nProps[name];
    const sub = (severity: Severity, code: string, message: string) =>
      ctx.add({ severity, code: `${dir}-${code}`, operation: ctx.op, location: loc, message });
    if (ns === undefined) {
      if (dir === "response") sub("breaking", "property-removed", "Property was removed from the response.");
      else if (n.additionalProperties === false) sub("breaking", "property-removed", "Property was removed and additional properties are not allowed.");
      else sub("warning", "property-removed", "Property was removed from the request schema.");
      continue;
    }
    if (dir === "request" && !oReq.has(name) && nReq.has(name)) sub("breaking", "property-became-required", "Property is now required.");
    if (dir === "response" && oReq.has(name) && !nReq.has(name)) sub("breaking", "property-became-optional", "Property is no longer guaranteed in the response.");
    compareSchema(os, ns, dir, { ...ctx, prop, seen, depth: depth + 1 });
  }
  for (const name of Object.keys(nProps)) {
    if (name in oProps) continue;
    if (dir === "request" && nReq.has(name)) {
      ctx.add({ severity: "breaking", code: "request-required-property-added", operation: ctx.op, location: at(ctx.loc, ctx.prop ? `${ctx.prop}.${name}` : name), message: "New required property." });
    }
  }

  if (o.items || n.items) compareSchema(o.items, n.items, dir, { ...ctx, prop: `${ctx.prop ?? ""}[]`, seen, depth: depth + 1 });
  if (o.additionalProperties && typeof o.additionalProperties === "object" && typeof n.additionalProperties === "object") {
    compareSchema(o.additionalProperties, n.additionalProperties, dir, { ...ctx, prop: `${ctx.prop ?? ""}{*}`, seen, depth: depth + 1 });
  }
  if (dir === "request" && o.additionalProperties !== false && n.additionalProperties === false && Object.keys(oProps).length) {
    emit("warning", "additional-properties-disallowed", "Additional properties are no longer allowed.");
  }

  for (const kw of ["oneOf", "anyOf"] as const) {
    const ov: any[] = Array.isArray(o[kw]) ? o[kw] : [];
    const nv: any[] = Array.isArray(n[kw]) ? n[kw] : [];
    if (!ov.length && !nv.length) continue;
    if (dir === "request" && nv.length < ov.length) emit("breaking", `${kw}-variant-removed`, `${ov.length - nv.length} ${kw} variant(s) removed.`);
    if (dir === "response" && nv.length > ov.length) emit("warning", `${kw}-variant-added`, `${nv.length - ov.length} new ${kw} variant(s) may be returned.`);
    const len = Math.min(ov.length, nv.length);
    for (let i = 0; i < len; i++) compareSchema(ov[i], nv[i], dir, { ...ctx, prop: `${ctx.prop ?? ""}<${kw}#${i + 1}>`, seen, depth: depth + 1 });
  }
}

function at(loc: string, prop?: string): string {
  return prop ? `${loc} › ${prop}` : loc;
}
