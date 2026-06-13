# PDF fonts

Local TTF files used by @react-pdf/renderer (Sprint 12 — Reports).

## Source

Font ZIPs are stored in `docs/templates/`:
- Big_Shoulders.zip
- DM_Sans.zip
- DM_Mono.zip

Extract the required weights below into this directory.

## Expected files

- BigShouldersDisplay-Bold.ttf
- DMSans-Regular.ttf
- DMSans-Medium.ttf
- DMSans-SemiBold.ttf
- DMMono-Regular.ttf

Reference from code via absolute path constructed with __dirname
so Node resolves them regardless of CWD.
