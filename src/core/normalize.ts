import { detectFlavor, listOperations, type HttpMethod } from "./parse.js";

/** Version-independent view of one operation, built from a dereferenced document. */
export interface NormParam {
  name: string;
  in: string;
  required: boolean;
  deprecated: boolean;
  schema: any;
}

export interface NormOperation {
  path: string;
  /** Path with parameter names erased, e.g. /users/{} — so renamed path params still match. */
  pathKey: string;
  method: HttpMethod;
  operationId?: string;
  deprecated: boolean;
  params: Map<string, NormParam>;
  body: { required: boolean; content: Map<string, any> } | null;
  responses: Map<string, Map<string, any>>;
  /** Alternatives (OR) of requirement sets (AND): each entry is "scheme:scope1,scope2". */
  security: string[][];
}

export function pathKey(path: string): string {
  return path.replace(/\{[^}]*\}/g, "{}").replace(/\/+$/, "") || "/";
}

const SWAGGER2_TO_SCHEMA_KEYS = [
  "type", "format", "items", "enum", "default", "minimum", "maximum", "exclusiveMinimum",
  "exclusiveMaximum", "minLength", "maxLength", "pattern", "minItems", "maxItems", "uniqueItems", "multipleOf",
];

function swagger2ParamSchema(p: any): any {
  if (p.schema) return p.schema;
  const s: any = {};
  for (const k of SWAGGER2_TO_SCHEMA_KEYS) if (p[k] !== undefined) s[k] = p[k];
  return s;
}

function normSecurity(req: any): string[][] {
  if (!Array.isArray(req)) return [];
  return req.map((alt: any) =>
    Object.entries<any>(alt ?? {})
      .map(([name, scopes]) => `${name}:${[...(scopes ?? [])].sort().join(",")}`)
      .sort(),
  );
}

export function normalizeOperations(doc: Record<string, any>): Map<string, NormOperation> {
  const swagger2 = detectFlavor(doc) === "swagger-2.0";
  const globalConsumes: string[] = doc.consumes ?? ["application/json"];
  const globalProduces: string[] = doc.produces ?? ["application/json"];
  const out = new Map<string, NormOperation>();

  for (const { path, method, op, pathItem } of listOperations(doc)) {
    const params = new Map<string, NormParam>();
    let body: NormOperation["body"] = null;
    const allParams = [...(pathItem.parameters ?? []), ...(op.parameters ?? [])];
    // Operation-level parameters override path-level ones with the same name+in.
    for (const p of allParams) {
      if (!p || typeof p !== "object") continue;
      if (swagger2 && p.in === "body") {
        const content = new Map<string, any>();
        for (const mt of op.consumes ?? globalConsumes) content.set(mt, p.schema ?? {});
        body = { required: p.required === true, content };
        continue;
      }
      if (swagger2 && p.in === "formData") {
        const mt = (op.consumes ?? globalConsumes).find((m: string) => m.includes("form")) ?? "application/x-www-form-urlencoded";
        body ??= { required: false, content: new Map([[mt, { type: "object", properties: {}, required: [] }]]) };
        const schema = body.content.get(mt) ?? [...body.content.values()][0];
        schema.properties[p.name] = swagger2ParamSchema(p);
        if (p.required) {
          schema.required.push(p.name);
          body.required = true;
        }
        continue;
      }
      const isPath = p.in === "path";
      // Path params are keyed by position-independent "path:*" names only when renamed; keep name for clarity.
      params.set(`${p.in}:${isPath ? p.name : String(p.name).toLowerCase()}`, {
        name: p.name,
        in: p.in,
        required: isPath ? true : p.required === true,
        deprecated: p.deprecated === true,
        schema: swagger2 ? swagger2ParamSchema(p) : (p.schema ?? firstContentSchema(p.content)),
      });
    }
    if (!swagger2 && op.requestBody) {
      const content = new Map<string, any>();
      for (const [mt, media] of Object.entries<any>(op.requestBody.content ?? {})) content.set(mt, media?.schema ?? {});
      body = { required: op.requestBody.required === true, content };
    }

    const responses = new Map<string, Map<string, any>>();
    for (const [code, resp] of Object.entries<any>(op.responses ?? {})) {
      const media = new Map<string, any>();
      if (swagger2) {
        if (resp?.schema) for (const mt of op.produces ?? globalProduces) media.set(mt, resp.schema);
      } else {
        for (const [mt, m] of Object.entries<any>(resp?.content ?? {})) media.set(mt, m?.schema ?? {});
      }
      responses.set(String(code).toUpperCase(), media);
    }

    const key = `${method.toUpperCase()} ${pathKey(path)}`;
    out.set(key, {
      path,
      pathKey: pathKey(path),
      method,
      operationId: op.operationId,
      deprecated: op.deprecated === true,
      params: renamePathParamsByPosition(path, params),
      body,
      responses,
      security: normSecurity(op.security ?? doc.security),
    });
  }
  return out;
}

function firstContentSchema(content: any): any {
  if (!content) return undefined;
  const first = Object.values<any>(content)[0];
  return first?.schema;
}

/** Re-key path params as path:#0, path:#1… so that renaming {id} → {userId} is not seen as remove+add. */
function renamePathParamsByPosition(path: string, params: Map<string, NormParam>): Map<string, NormParam> {
  const names = [...path.matchAll(/\{([^}]*)\}/g)].map((m) => m[1]);
  const out = new Map<string, NormParam>();
  for (const [k, v] of params) {
    if (v.in === "path") {
      const idx = names.indexOf(v.name);
      out.set(idx >= 0 ? `path:#${idx}` : k, v);
    } else out.set(k, v);
  }
  return out;
}
