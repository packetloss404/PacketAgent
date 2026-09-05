# Self-hosted fonts

These files are served from PacketAgent's own origin so the workbench makes no
third-party request on page load and the Content-Security-Policy needs no
external `style-src` or `font-src` entry.

Every subset Google Fonts publishes for these families is vendored: `latin`,
`latin-ext`, `cyrillic`, `cyrillic-ext`, and `vietnamese`. Each `@font-face`
carries a `unicode-range`, so a browser downloads only the files the page's
characters actually need — a latin-only page fetches the latin files and
nothing else.

| Family | Weights | Upstream |
| --- | --- | --- |
| Geist | 300, 400, 500, 600, 700 | https://github.com/vercel/geist-font |
| Geist Mono | 400, 500 | https://github.com/vercel/geist-font |
| Instrument Serif | 400 | https://github.com/Instrument/instrument-serif |

Geist and Geist Mono are © 2023 Vercel, in collaboration with basement.studio.
Instrument Serif is © 2022 The Instrument Serif Project Authors.

All three are licensed under the SIL Open Font License, Version 1.1. The full
license text is in [OFL.txt](./OFL.txt).

Regenerate with the `@font-face` rules in `web/src/fonts.css`; the file names
encode family, weight, and subset.
