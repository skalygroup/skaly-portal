# Skaly Portal — Code Components

These are the **real** shadcn/Radix + Tailwind v4 components from the Skaly
Business Portal (`apps/web`). Build with them as-is; every class below exists in
the shipped `styles.css` closure.

## Dark-only — wrap your screen in `.dark`

The portal is **dark-only**. The shadcn semantic tokens (`primary`, `card`,
`muted`, …) ship with light values at `:root` and their dark values under the
`.dark` class. **Put `className="dark"` on a top-level wrapper** (and give it a
dark background such as `bg-bg-base` or `bg-bg-surface`), or the components
render in the wrong, light palette.

```tsx
<div className="dark min-h-screen bg-bg-base text-text-primary">
  {/* your screen */}
</div>
```

`BrandPanel` is the exception — it ships its own dark field and tokens, so it
needs no wrapper.

## Two token families (both are Tailwind utilities)

**1. Brand tokens** — the Skaly design language; use these for page chrome,
surfaces, and the gold accent:

| Purpose | Utilities |
|---|---|
| Surfaces | `bg-bg-base` `bg-bg-surface` `bg-bg-elevated` `bg-bg-hover` `bg-bg-selected` |
| Text | `text-text-primary` `text-text-secondary` `text-text-muted` `text-text-disabled` |
| Borders | `border-border-subtle` `border-border-default` `border-border-strong` |
| Gold accent (primary action) | `bg-accent-gold` `text-accent-gold` `hover:bg-accent-gold-hover` |
| Status | `…-status-green` `…-status-blue` `…-status-amber` `…-status-red` `…-status-teal` `…-status-grey` (prefix `bg-`/`text-`/`border-`) |

**2. shadcn semantic tokens** — used internally by the `ui/` primitives; reach
for these when extending them: `bg-primary` / `text-primary-foreground`,
`bg-card` / `text-card-foreground`, `bg-muted` / `text-muted-foreground`,
`border-input`, `bg-destructive` / `text-destructive`, `bg-secondary`.

**Fonts** (CSS vars, applied via arbitrary utilities):
`font-[family-name:var(--font-display)]` (Big Shoulders — headings),
`var(--font-body)` (DM Sans — default), `font-[family-name:var(--font-mono)]`
(DM Mono — labels/footers).

## The gold action pattern

The brand's primary action is **not** the shadcn primary button — it's a
gold-filled control (see `BrandPanel` and the login screen). For a primary CTA,
prefer the gold pattern; use `<Button>` (shadcn) for secondary/neutral actions.

```tsx
<button className="flex h-[46px] w-full items-center justify-center rounded-md
  bg-accent-gold text-[15px] font-semibold text-bg-base
  transition-colors hover:bg-accent-gold-hover active:scale-[0.985]">
  Sign in
</button>
```

## Where the truth lives

- `styles.css` (+ its `@import`s: `_ds_bundle.css`, `tokens/`) — every token and
  utility. Read it before inventing class names.
- `components/<group>/<Name>/<Name>.d.ts` — the prop contract.
- `components/<group>/<Name>/<Name>.prompt.md` — per-component usage.

## Components

`Button` (variants: default/secondary/outline/ghost/destructive/link; sizes:
xs/sm/default/lg/icon\*), `Input`, `Label`, `Alert` (+ `AlertTitle`,
`AlertDescription`; variants default/destructive), the `Form` stack
(`Form`/`FormField`/`FormItem`/`FormLabel`/`FormControl`/`FormDescription`/`FormMessage`,
built on react-hook-form), and `BrandPanel` (the auth split-screen panel).

## Idiomatic example

```tsx
import { Label, Input, Button } from "@skaly/web";

<div className="dark bg-bg-surface rounded-xl p-6 max-w-sm">
  <h2 className="font-[family-name:var(--font-display)] text-2xl font-bold text-text-primary">
    Invite teammate
  </h2>
  <div className="mt-4 grid gap-2">
    <Label htmlFor="email">Work email</Label>
    <Input id="email" type="email" placeholder="you@skalygroup.com" />
  </div>
  <Button className="mt-4 w-full">Send invite</Button>
</div>
```
