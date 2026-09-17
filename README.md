# Publish OpenAPI to Confluence

Keep your Confluence API docs in sync with your repository, and **stop breaking API changes in pull requests** before they reach consumers.

This action uploads an OpenAPI 3.x or Swagger 2.0 spec to a Confluence Cloud page as a versioned attachment. It compares the spec with the version already published and reports every breaking change, warning and non-breaking change in the job summary.

Pair it with [API Docs for Confluence](https://fernlight.dev) to render the attachment as interactive API reference, with a "what changed" panel, on the page.

## Quick start

1. Create an [Atlassian API token](https://id.atlassian.com/manage-profile/security/api-tokens) for an account that can edit the target page.
2. Add repository secrets `CONFLUENCE_EMAIL` and `CONFLUENCE_API_TOKEN`.
3. Find the page ID: it's the number in the page URL (`…/pages/123456/My+API`).

### Publish on every push to main

```yaml
name: Publish API docs
on:
  push:
    branches: [main]
    paths: [openapi.yaml]

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: fernlightnz/publish-openapi-to-confluence@v1
        with:
          spec: openapi.yaml
          confluence-url: https://yourcompany.atlassian.net
          page-id: "123456"
          email: ${{ secrets.CONFLUENCE_EMAIL }}
          api-token: ${{ secrets.CONFLUENCE_API_TOKEN }}
          fail-on: none   # always publish from main; the change report still appears in the summary
```

### Block breaking changes in pull requests

```yaml
name: API compatibility
on:
  pull_request:
    paths: [openapi.yaml]

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: fernlightnz/publish-openapi-to-confluence@v1
        with:
          mode: check
          spec: openapi.yaml
          confluence-url: https://yourcompany.atlassian.net
          page-id: "123456"
          email: ${{ secrets.CONFLUENCE_EMAIL }}
          api-token: ${{ secrets.CONFLUENCE_API_TOKEN }}
          fail-on: breaking
```

The job summary shows a table like this:

| Severity | Operation | Where | Change |
|---|---|---|---|
| 🔴 Breaking | `POST /payments` | `header parameter "Idempotency-Key"` | Optional parameter is now required. |
| 🔴 Breaking | `POST /payments/{payment_id}/void` | | Operation was removed. |
| 🟠 Warning | `GET /payments` | `response 200 › application/json › data[].status` | May now return "refunded"; strict clients may fail. |

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `spec` | yes | | Path to the OpenAPI/Swagger file (YAML or JSON). |
| `confluence-url` | yes | | e.g. `https://yourcompany.atlassian.net` |
| `page-id` | yes | | Numeric ID of the page that holds the attachment. |
| `email` | yes | | Account email for the API token. |
| `api-token` | yes | | Atlassian API token. Use a secret. |
| `mode` | no | `publish` | `publish` uploads a new attachment version; `check` only compares. |
| `fail-on` | no | `breaking` | `breaking`, `warning` or `none`. In `publish` mode, a failing check also skips the upload. |
| `attachment-name` | no | spec file name | Attachment name on the page. |
| `comment` | no | `Published from <repo>@<sha>` | Attachment version comment. |

## Outputs

`breaking`, `warnings`, `info`, `published` (`true`/`false`), `attachment-version`, `report` (Markdown).

## What counts as breaking?

Removed operations and success responses; newly required parameters, request bodies and request properties; changed types, formats and patterns; removed request enum values; media types no longer accepted or returned; new authentication requirements or removed auth schemes; response properties removed or no longer guaranteed. See the [full list](https://fernlight.dev/docs/#changes).

## Security

- The token is used only for calls to your own Confluence site and is masked in logs.
- Specs are read locally and sent only to your Confluence site; external `$ref`s are never fetched.
- The action has no runtime dependencies to install: it's a single bundled file.

## License

MIT © Fernlight
