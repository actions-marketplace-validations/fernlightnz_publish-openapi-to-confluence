import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { confluenceClient, type AttachmentStore, type RemoteAttachment } from "../src/confluence.js";
import { parseFailOn, parseMode, run, type RunInputs } from "../src/run.js";

const fixture = (n: string) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), "utf8");
const v1 = fixture("payments-v1.yaml");
const v2 = fixture("payments-v2.yaml");

function memoryStore(initial?: string) {
  const versions: string[] = initial ? [initial] : [];
  const uploads: { fileName: string; comment: string }[] = [];
  const att = (): RemoteAttachment => ({ id: "att1", title: "payments.yaml", version: versions.length, downloadPath: "/download/attachments/1/payments.yaml" });
  const store: AttachmentStore = {
    find: async (_page, name) => (versions.length && name === "payments.yaml" ? att() : null),
    download: async () => versions.at(-1)!,
    upload: async (_page, fileName, text, comment) => {
      versions.push(text);
      uploads.push({ fileName, comment });
      return att();
    },
  };
  return { store, uploads, versions };
}

const inputs = (over: Partial<RunInputs> = {}): RunInputs => ({
  specPath: "api/payments.yaml",
  specText: v2,
  pageId: "123",
  mode: "publish",
  failOn: "breaking",
  comment: "Published from acme/api@abc1234",
  ...over,
});

describe("run", () => {
  it("publishes a first version when nothing is on the page", async () => {
    const { store, uploads } = memoryStore();
    const r = await run(inputs({ failOn: "breaking" }), store);
    expect(r.ok).toBe(true);
    expect(r.published).toBe(true);
    expect(r.attachmentVersion).toBe(1);
    expect(uploads).toEqual([{ fileName: "payments.yaml", comment: "Published from acme/api@abc1234" }]);
    expect(r.report).toContain("nothing to compare");
  });

  it("blocks publishing when breaking changes are found", async () => {
    const { store, uploads } = memoryStore(v1);
    const r = await run(inputs(), store);
    expect(r.ok).toBe(false);
    expect(r.published).toBe(false);
    expect(r.summary.breaking).toBe(4);
    expect(uploads).toHaveLength(0);
    expect(r.failureReason).toMatch(/4 breaking/);
    expect(r.report).toContain("🔴 Breaking");
    expect(r.report).toContain("Not published");
  });

  it("publishes despite breaking changes with fail-on none", async () => {
    const { store, versions } = memoryStore(v1);
    const r = await run(inputs({ failOn: "none" }), store);
    expect(r.ok).toBe(true);
    expect(r.published).toBe(true);
    expect(r.attachmentVersion).toBe(2);
    expect(versions).toHaveLength(2);
  });

  it("check mode never uploads", async () => {
    const { store, uploads } = memoryStore(v1);
    const r = await run(inputs({ mode: "check", failOn: "none" }), store);
    expect(r.published).toBe(false);
    expect(uploads).toHaveLength(0);
    expect(r.summary.breaking).toBe(4);
  });

  it("fail-on warning also counts warnings", async () => {
    const { store } = memoryStore(v1);
    const r = await run(inputs({ mode: "check", failOn: "warning" }), store);
    expect(r.ok).toBe(false);
    expect(r.failureReason).toMatch(/or warning/);
  });

  it("skips upload when the spec is unchanged", async () => {
    const { store, uploads } = memoryStore(v2);
    const r = await run(inputs(), store);
    expect(r.ok).toBe(true);
    expect(r.published).toBe(false);
    expect(uploads).toHaveLength(0);
    expect(r.report).toContain("identical");
  });

  it("publishes over a corrupt published attachment without comparing", async () => {
    const { store, uploads } = memoryStore("{{ not: [yaml");
    const r = await run(inputs(), store);
    expect(r.ok).toBe(true);
    expect(uploads).toHaveLength(1);
    expect(r.report).toContain("nothing to compare");
  });

  it("rejects documents that are not OpenAPI", async () => {
    const { store, uploads } = memoryStore();
    const r = await run(inputs({ specText: "name: not a spec\n" }), store);
    expect(r.ok).toBe(false);
    expect(uploads).toHaveLength(0);
    expect(r.report).toContain("not a usable OpenAPI spec");
  });

  it("uses attachment-name when given", async () => {
    const { store, uploads } = memoryStore();
    await run(inputs({ attachmentName: "orders.yaml" }), store);
    expect(uploads[0].fileName).toBe("orders.yaml");
  });
});

describe("input parsing", () => {
  it("validates mode and fail-on", () => {
    expect(parseMode("")).toBe("publish");
    expect(parseMode("CHECK")).toBe("check");
    expect(() => parseMode("deploy")).toThrow(/Invalid mode/);
    expect(parseFailOn(undefined)).toBe("breaking");
    expect(() => parseFailOn("error")).toThrow(/Invalid fail-on/);
  });
});

describe("confluenceClient", () => {
  it("sends basic auth, finds, downloads and uploads", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (url.includes("?filename=")) {
        return Response.json({ results: [{ id: "att9", title: "a.yaml", version: { number: 3 }, _links: { download: "/download/attachments/5/a.yaml?version=3" } }] });
      }
      if (url.includes("/download/")) return new Response("openapi: 3.1.0");
      return Response.json({ results: [{ id: "att9", title: "a.yaml", version: { number: 4 }, _links: {} }] });
    }) as unknown as typeof fetch;

    const c = confluenceClient("https://acme.atlassian.net/wiki/", "me@acme.com", "tok", fakeFetch);
    const att = await c.find("5", "a.yaml");
    expect(att).toMatchObject({ id: "att9", version: 3 });
    expect(await c.download(att!)).toBe("openapi: 3.1.0");
    const up = await c.upload("5", "a.yaml", "openapi: 3.1.0", "msg");
    expect(up.version).toBe(4);

    expect(calls[0].url).toBe("https://acme.atlassian.net/wiki/rest/api/content/5/child/attachment?filename=a.yaml&expand=version");
    expect(calls[1].url).toBe("https://acme.atlassian.net/wiki/download/attachments/5/a.yaml?version=3");
    expect((calls[0].init.headers as any).Authorization).toBe("Basic " + Buffer.from("me@acme.com:tok").toString("base64"));
    expect(calls[2].init.method).toBe("PUT");
    expect((calls[2].init.headers as any)["X-Atlassian-Token"]).toBe("no-check");
  });

  it("explains auth failures", async () => {
    const fakeFetch = (async () => new Response("nope", { status: 401 })) as unknown as typeof fetch;
    const c = confluenceClient("https://acme.atlassian.net", "me@acme.com", "bad", fakeFetch);
    await expect(c.find("5", "a.yaml")).rejects.toThrow(/401.*email and API token/);
  });
});
