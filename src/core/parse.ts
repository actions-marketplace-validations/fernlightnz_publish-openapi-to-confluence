import SwaggerParser from "@apidevtools/swagger-parser";
import { parse as parseYaml } from "yaml";

export type SpecFlavor = "swagger-2.0" | "openapi-3.0" | "openapi-3.1" | "openapi-3.2" | "unknown";

export interface ParsedSpec {
  flavor: SpecFlavor;
  /** Raw document as authored (refs intact). */
  raw: Record<string, any>;
  /** Fully dereferenced document, or null when dereferencing failed. */
  dereferenced: Record<string, any> | null;
  title: string;
  version: string;
  /** Hard problems: the spec could not be parsed or failed schema validation. */
  errors: string[];
}

export class SpecSyntaxError extends Error {}

/** Parse JSON or YAML text into a plain object. */
export function parseText(text: string): Record<string, any> {
  const trimmed = text.replace(/^﻿/, "").trim();
  if (!trimmed) throw new SpecSyntaxError("The spec is empty.");
  let doc: unknown;
  try {
    doc = trimmed.startsWith("{") ? JSON.parse(trimmed) : parseYaml(trimmed, { maxAliasCount: 1000 });
  } catch (e) {
    throw new SpecSyntaxError(`Could not parse the spec as JSON or YAML: ${(e as Error).message}`);
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    throw new SpecSyntaxError("The spec must be a JSON or YAML object.");
  }
  return doc as Record<string, any>;
}

export function detectFlavor(doc: Record<string, any>): SpecFlavor {
  if (typeof doc.swagger === "string" && doc.swagger.startsWith("2.")) return "swagger-2.0";
  const v = typeof doc.openapi === "string" ? doc.openapi : "";
  if (v.startsWith("3.0")) return "openapi-3.0";
  if (v.startsWith("3.1")) return "openapi-3.1";
  if (v.startsWith("3.2")) return "openapi-3.2";
  return "unknown";
}

export interface LoadOptions {
  /** Transform the raw document before validation/dereferencing (e.g. filtering). */
  prepare?: (doc: Record<string, any>) => Record<string, any>;
  /**
   * Full JSON-Schema validation (default true). It compiles validators with `new Function`,
   * which Content-Security-Policies such as Atlassian Forge's forbid, so browsers pass false
   * and get lightweight structural checks instead.
   */
  validate?: boolean;
}

/**
 * Parse, validate and dereference a spec. Never throws for invalid specs:
 * problems are reported in `errors` so the UI can still render what it can.
 * External $refs are never resolved (no network or filesystem access).
 */
export async function loadSpec(text: string, opts: LoadOptions = {}): Promise<ParsedSpec> {
  const parsed = parseText(text);
  const raw = opts.prepare ? opts.prepare(parsed) : parsed;
  const flavor = detectFlavor(raw);
  const errors: string[] = [];
  if (flavor === "unknown") {
    errors.push('Not an OpenAPI or Swagger document: missing a top-level "openapi" or "swagger" version field.');
  }
  const resolve = { external: false } as const;
  if (flavor !== "unknown" && opts.validate === false) {
    errors.push(...structuralProblems(raw));
  } else if (flavor !== "unknown" && flavor !== "openapi-3.2") {
    try {
      await SwaggerParser.validate(structuredClone(raw) as any, { resolve, dereference: { circular: true } } as any);
    } catch (e) {
      errors.push(cleanValidationMessage((e as Error).message));
    }
  }
  let dereferenced: Record<string, any> | null = null;
  if (flavor !== "unknown") {
    try {
      dereferenced = (await SwaggerParser.dereference(annotateSchemaNames(structuredClone(raw)) as any, {
        resolve,
        dereference: { circular: true },
      } as any)) as any;
    } catch (e) {
      errors.push(`Could not resolve $refs: ${(e as Error).message}`);
    }
  }
  return {
    flavor,
    raw,
    dereferenced,
    title: String(raw.info?.title ?? "Untitled API"),
    version: String(raw.info?.version ?? ""),
    errors: [...new Set(errors)],
  };
}

/** Cheap checks that catch the most common authoring mistakes without a schema validator. */
export function structuralProblems(doc: Record<string, any>): string[] {
  const out: string[] = [];
  if (!doc.info || typeof doc.info !== "object") out.push('Missing required "info" object.');
  else {
    if (typeof doc.info.title !== "string") out.push('Missing required "info.title".');
    if (doc.info.version === undefined) out.push('Missing required "info.version".');
  }
  if (doc.paths !== undefined && (typeof doc.paths !== "object" || Array.isArray(doc.paths))) out.push('"paths" must be an object.');
  if (detectFlavor(doc) !== "openapi-3.1" && doc.paths === undefined) out.push('Missing required "paths" object.');
  for (const path of Object.keys(doc.paths ?? {})) {
    if (!path.startsWith("/")) out.push(`Path "${path}" must start with "/".`);
  }
  return out;
}

/** Tag named component schemas with x-schema-name so names survive dereferencing. */
export function annotateSchemaNames(doc: Record<string, any>): Record<string, any> {
  const named = doc.components?.schemas ?? doc.definitions ?? {};
  for (const [name, schema] of Object.entries<any>(named)) {
    if (schema && typeof schema === "object" && !Array.isArray(schema) && !schema.$ref && schema["x-schema-name"] === undefined) {
      schema["x-schema-name"] = name;
    }
  }
  return doc;
}

function cleanValidationMessage(msg: string): string {
  return msg.replace(/\s+/g, " ").trim().slice(0, 2000);
}

export const HTTP_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export interface OperationRef {
  path: string;
  method: HttpMethod;
  op: Record<string, any>;
  pathItem: Record<string, any>;
}

export function listOperations(doc: Record<string, any>): OperationRef[] {
  const out: OperationRef[] = [];
  for (const [path, pathItem] of Object.entries<any>(doc.paths ?? {})) {
    if (!pathItem || typeof pathItem !== "object") continue;
    for (const method of HTTP_METHODS) {
      if (pathItem[method]) out.push({ path, method, op: pathItem[method], pathItem });
    }
  }
  return out;
}
