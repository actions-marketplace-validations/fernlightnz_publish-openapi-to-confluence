/** Minimal Confluence Cloud REST client for page attachments (basic auth with an API token). */

export interface RemoteAttachment {
  id: string;
  title: string;
  version: number;
  downloadPath: string;
}

export interface AttachmentStore {
  find(pageId: string, fileName: string): Promise<RemoteAttachment | null>;
  download(att: RemoteAttachment): Promise<string>;
  upload(pageId: string, fileName: string, text: string, comment: string): Promise<RemoteAttachment>;
}

export class ConfluenceError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

type Fetch = typeof fetch;

export function confluenceClient(siteUrl: string, email: string, token: string, fetchImpl: Fetch = fetch): AttachmentStore {
  const base = siteUrl.replace(/\/+$/, "").replace(/\/wiki$/, "");
  const auth = "Basic " + Buffer.from(`${email}:${token}`).toString("base64");

  async function call(path: string, init: RequestInit = {}): Promise<Response> {
    const res = await fetchImpl(base + path, { ...init, headers: { Authorization: auth, Accept: "application/json", ...(init.headers ?? {}) } });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 300);
      const hint =
        res.status === 401 ? " Check the email and API token." :
        res.status === 403 ? " The account needs permission to view and edit the page and add attachments." :
        res.status === 404 ? " Check confluence-url and page-id, and that the account can see the page." : "";
      throw new ConfluenceError(`Confluence returned HTTP ${res.status} for ${init.method ?? "GET"} ${path}.${hint} ${body}`.trim(), res.status);
    }
    return res;
  }

  const toAttachment = (a: any): RemoteAttachment => ({
    id: String(a.id),
    title: String(a.title),
    version: Number(a.version?.number ?? 1),
    downloadPath: String(a._links?.download ?? ""),
  });

  return {
    async find(pageId, fileName) {
      const res = await call(`/wiki/rest/api/content/${encodeURIComponent(pageId)}/child/attachment?filename=${encodeURIComponent(fileName)}&expand=version`);
      const body: any = await res.json();
      const hit = (body.results ?? []).find((a: any) => a.title === fileName);
      return hit ? toAttachment(hit) : null;
    },

    async download(att) {
      const res = await call(`/wiki${att.downloadPath}`, { headers: { Accept: "*/*" } });
      return res.text();
    },

    async upload(pageId, fileName, text, comment) {
      const form = new FormData();
      const type = /\.json$/i.test(fileName) ? "application/json" : "application/yaml";
      form.append("file", new Blob([text], { type }), fileName);
      form.append("comment", comment);
      form.append("minorEdit", "true");
      const res = await call(`/wiki/rest/api/content/${encodeURIComponent(pageId)}/child/attachment?expand=version`, {
        method: "PUT",
        headers: { "X-Atlassian-Token": "no-check" },
        body: form,
      });
      const body: any = await res.json();
      return toAttachment(body.results?.[0] ?? body);
    },
  };
}
