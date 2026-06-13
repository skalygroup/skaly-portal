# UI & Design Templates

Reference templates for building the Skaly Business Portal UI.
These are component prompt files — each contains ready-to-use React/TSX
code with shadcn/ui, Tailwind CSS, and Framer Motion patterns.

## Component Templates (Prompts)

| File | Component | Use Case |
|------|-----------|----------|
| prompt-1-spline-scene.md | Spline 3D scene + Spotlight | Interactive 3D hero sections |
| prompt-2-glass-account-settings.md | Glassmorphism settings card | Profile / account settings pages |
| prompt-3-hero-section.md | Hero + Header with nav menu | Landing page / marketing header |
| prompt-4-section-with-mockup.md | Section with app mockup cards | Feature showcase sections |
| prompt-5-hero-animated.md | Animated hero + logo strip | Full landing page with AnimatedGroup |

## Font Files

Three Google Font families bundled as ZIPs for offline/PDF use:

- Big_Shoulders.zip — display headings (`--font-display`)
- DM_Sans.zip — body text (`--font-body`)
- DM_Mono.zip — code / monospace (`--font-mono`)

Extract TTFs to `apps/api/src/assets/fonts/` for Sprint 12 PDF
report generation via @react-pdf/renderer.

## How to Use

These templates serve as **design reference** for Sprint 1+.
When building a page, read the relevant prompt file and adapt its
patterns (colors, copy, layout) to match the Skaly design system
defined in `docs/03-UIUX.md` §2.1.
