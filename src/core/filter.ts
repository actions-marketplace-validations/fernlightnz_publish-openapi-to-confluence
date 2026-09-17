import { HTTP_METHODS } from "./parse.js";

export interface FilterOptions {
  /** Keep only operations carrying at least one of these tags. Empty = all. */
  tags?: string[];
  /** Keep only paths matching one of these globs (`*` = one segment, `**` = any). Empty = all. */
  paths?: string[];
  /** Keep only these HTTP methods. Empty = all. */
  methods?: string[];
  /** Drop operations marked deprecated. */
  hideDeprecated?: boolean;
  hideServers?: boolean;
  hideDescription?: boolean;
}

export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      re += ".*";
      i++;
    } else if (c === "*") {
      re += "[^/]*";
    } else {
      re += c.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`);
}

/** Returns a filtered copy of an (un-dereferenced or dereferenced) OpenAPI/Swagger document. */
export function filterSpec(doc: Record<string, any>, opts: FilterOptions): Record<string, any> {
  const out = structuredClone(doc);
  const tags = new Set((opts.tags ?? []).map((t) => t.trim()).filter(Boolean));
  const pathRes = (opts.paths ?? []).map((p) => p.trim()).filter(Boolean).map(globToRegExp);
  const methods = new Set((opts.methods ?? []).map((m) => m.trim().toLowerCase()).filter(Boolean));
  const usedTags = new Set<string>();

  const paths: Record<string, any> = {};
  for (const [path, item] of Object.entries<any>(out.paths ?? {})) {
    if (pathRes.length && !pathRes.some((r) => r.test(path))) continue;
    const kept = { ...item };
    let any = false;
    for (const m of HTTP_METHODS) {
      const op = kept[m];
      if (!op) continue;
      const opTags: string[] = Array.isArray(op.tags) ? op.tags : [];
      const drop =
        (methods.size && !methods.has(m)) ||
        (tags.size && !opTags.some((t) => tags.has(t))) ||
        (opts.hideDeprecated && op.deprecated === true);
      if (drop) delete kept[m];
      else {
        any = true;
        opTags.forEach((t) => usedTags.add(t));
      }
    }
    if (any) paths[path] = kept;
  }
  out.paths = paths;

  if (Array.isArray(out.tags) && (tags.size || pathRes.length || methods.size || opts.hideDeprecated)) {
    out.tags = out.tags.filter((t: any) => usedTags.has(t?.name));
  }
  if (opts.hideServers) {
    delete out.servers;
    delete out.host;
    delete out.basePath;
    delete out.schemes;
  }
  if (opts.hideDescription && out.info) delete out.info.description;
  return out;
}
