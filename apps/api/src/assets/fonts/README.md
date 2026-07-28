# PDF fonts

Local TTF files used by `@react-pdf/renderer` (Sprint 11 — Reports, ADR-027).

## Source

Font ZIPs are stored in `docs/templates/`:
- `Big_Shoulders.zip`
- `DM_Sans.zip`
- `DM_Mono.zip`

Extract the required weights below into this directory. **Done** — the five files are
committed alongside this README.

Use the **static** weights, never the `*-VariableFont_*.ttf` files: `@react-pdf/renderer`
does not resolve variable-font axes, so a variable file renders at one arbitrary weight
and every `fontWeight` in the stylesheet silently does nothing.

## Files

| File | Used for |
|---|---|
| `BigShoulders-Bold.ttf` | Report title and section headings (UIUX §5 display face) |
| `DMSans-Regular.ttf` | Body text |
| `DMSans-Medium.ttf` | Table headers, emphasis |
| `DMSans-SemiBold.ttf` | Labels |
| `DMMono-Regular.ttf` | All data — periods, counts, dates, ids (UIUX §5) |

## Why they are vendored

`Font.register` accepts a URL, and that is the trap ADR-027 names: a network fetch
inside a render is an unbounded stall in the middle of a timed operation, and it
presents as *"report generation is slow in a way that doesn't match render
complexity"*. These are read from disk, so a render's cost is a function of the
document alone.

Paths are built off `import.meta.url`, not `process.cwd()` — the render runs inside a
worker thread, and the worker's CWD is whatever started the API.

## Upstream naming

Google renamed the family from *Big Shoulders Display* to *Big Shoulders*, so the zip
ships `BigShoulders-Bold.ttf`. This README originally listed
`BigShouldersDisplay-Bold.ttf`, which does not exist in the archive; the name above
matches the file.
