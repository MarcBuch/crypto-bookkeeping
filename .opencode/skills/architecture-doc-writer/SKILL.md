---
name: architecture-doc-writer
description: Writes a single HTML architecture document for a requested module or data flow.
disable-model-invocation: true
---

# Architecture Doc Writer

Write a single HTML architecture document for any user-specified module, subsystem, route, sync flow, or data flow.

This skill is user-invoked only. Use it when the user explicitly wants architecture documentation, data-flow documentation, fetch-flow documentation, module documentation, or a single HTML page in `docs/` explaining how part of the system works.

## Output

- Write exactly one HTML file in `docs/`.
- Use a filename derived from the requested scope: `docs/<scope>-architecture.html`.
- If the user provides a filename, use it.

## Required HTML Boilerplate

Every generated document must include these exact imports in the `<head>`:

```html
<script src="https://cdn.tailwindcss.com"></script>
<script type="module">
  import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";

  mermaid.initialize({ startOnLoad: true, theme: "neutral", securityLevel: "loose" });
</script>
```

## Workflow

### Step 1: Bound the scope

- Identify the exact thing the user wants documented.
- If the request is too broad, narrow it to one subsystem, one user journey, one module, or one data flow before writing.
- Decide the output filename slug if the user did not specify one.

Done when you can state the documentation scope in one sentence and name the output file.

### Step 2: Trace the real implementation

- Read the code before drafting anything.
- Always delegate codebase exploration to the `codebase-explorer` subagent first.
- Trace the runtime path end to end using the real code, not inferred intent.
- Follow the flow across the relevant layers:
  - entrypoints
  - UI/screens/routes
  - hooks/controllers/orchestration
  - API clients or transport
  - server routes/endpoints
  - domain services
  - persistence/cache
  - external systems

Done when you can explain the path from the first caller to the final data source and back.

### Step 3: Separate the architecture concerns

- Distinguish normal read behavior from write, mutation, refresh, or sync behavior.
- Identify which values are:
  - fetched or loaded
  - computed and persisted
  - computed only for display
- Identify whether reads are:
  - browser-cached
  - server-cached
  - materialized in storage
  - live from storage
  - live from external systems
- Capture loading, error, empty, and refresh states when they exist.

Done when the system can be described by layer and by runtime mode without ambiguity.

### Step 4: Draft the diagrams

- Include a system overview diagram showing the major layers and data flow.
- Include a sequence diagram when there is a meaningful request, sync, or refresh flow.
- Make diagrams reflect runtime behavior, not desired future architecture.

Done when the diagrams match the traced implementation and add clarity beyond prose.

### Step 5: Write the HTML page

- Create a single self-contained HTML page in `docs/`.
- Use Tailwind utility classes directly in the markup.
- Embed Mermaid blocks directly in the page.
- Use actual file paths from the repository.
- Keep the styling neutral, readable, and suitable for both desktop and mobile.

Done when the file exists and covers the requested scope completely.

### Step 6: Verify

- Read the generated file back.
- Verify the output path is correct.
- Verify the file references, section titles, and diagrams match the code you traced.
- Report the created file path to the user.

Done when the generated document is internally consistent and grounded in the implementation.

## Required Sections In Every Document

Every generated HTML page must include these sections when they are relevant to the requested scope:

1. Title and short summary
2. Overview cards
3. System overview diagram
4. Primary runtime flow
5. Read path by layer
6. Write, mutation, refresh, or sync flow
7. Cache and live-read boundaries
8. Computation ownership
9. Loading, error, empty, and refresh behavior
10. Important files
11. Final summary

If a section is not relevant, omit it rather than inventing content.

## Quality Checklist

Before finishing, confirm all of the following:

- The entrypoint is identified.
- The caller chain is traced end to end.
- Persistence or storage is identified.
- External systems are identified.
- Cache boundaries are identified.
- Live-read boundaries are identified.
- Refresh or sync behavior is described when present.
- Computed versus stored values are distinguished.
- User-visible loading or error states are described when present.
- Every important claim is backed by code you actually read.

## Rules

- Do not invent architecture that is not present in the code.
- Do not describe desired behavior as if it were implemented.
- Do not skip code tracing and jump straight to writing.
- Do not produce multiple files unless the user explicitly asks for more than one.
- Prefer concise, factual prose over generic architecture language.
- Prefer a single accurate page over a broader but speculative document.

## Example Requests

- `Document how the web app fetches LP positions and pnl data`
- `Document how the tax ledger fetches transactions`
- `Document the hedge sync pipeline`
- `Document the architecture of this module`
- `Create a single HTML page in docs for this data flow`
