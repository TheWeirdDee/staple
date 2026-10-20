# Landing redesign

The landing page now explains the customer, account model, quoting controls and inspection path before introducing architecture and implementation status. It retains Staple's paper and blue palette, with a framed hero, contrasting inset navigation and an original engraved market-depth background.

The hero's quoting desk is a deterministic illustration. It has no account connection, network calls, transaction hashes or performance metrics. Its sequence distinguishes published rules, placed quotes, execution checks, pending cancellation and confirmed withdrawal of orders. Remaining inventory risk is explicit. The example controls change illustrative values only; drafting a real policy opens the existing console.

The rest of the page uses an editorial explanation, three specific benefits, a compact sticky process sequence, annotated controls, recorded evidence, six accessible FAQ items and a final drafting action. Evidence counts come from the existing evidence index. The real testnet loop remains unpublished. No contracts, trading behavior, wallet permissions or backend connections were changed.

## Reference and asset provenance

The rendered [ChronicleAI site](https://chronicle-ai-web.vercel.app/) and its [source repository](https://github.com/zaikaman/ChronicleAI) were inspected before implementation, including `hero.tsx`, `how-it-works.tsx`, `header.tsx`, `features/home/HomePage.tsx`, `DESIGN.md`, and the BG AVIF/WebP/JPEG background arrangement.

The adaptation uses the framed hero, inset navigation, spring-based pointer movement, staged entrance and sticky process/progress principles. It uses different composition density, branding, colors, copy and product mechanics. No ChronicleAI artwork or source component was copied into Staple.

`web/public/art/engraved-depth.svg` is an original, approximately 16 KB SVG created for Staple under this repository's MIT license. It uses static contours and stippling, without animated noise filters or third-party images. Precise product information remains HTML. Asset URLs honor Vite's configured base path. Existing font families and the existing Framer Motion dependency are reused.

## Changed implementation

- `web/src/pages/Landing.tsx`: complete narrative and section redesign, real evidence loading and illustrative controls.
- `web/src/pages/landing.css`: scoped tokens, typography, responsive layouts, texture framing, interaction and motion styles.
- `web/src/components/QuotingWorkflow.tsx`: animated illustrative order book with manual steps, pause, reduced-motion support, and offscreen/hidden-tab suspension.
- `web/src/components/Layout.tsx`: landing navigation, working section anchors, keyboard menu behavior, functional skip link, concise landing footer and neutral public-mandate wording.
- `web/src/components/LoopDiagram.tsx`: obsolete component removed; its unused media rule was removed from `web/src/styles.css`.
- `web/e2e/landing.mjs`: repeatable production-preview browser checks and screenshot capture.

## Verification

The production web typecheck/build passed. There is no configured lint task; formatting was checked with Prettier. The existing owner-flow suite passed all 23 checks against real local contracts and an exchange test double. This is regression coverage, not live exchange verification.

`runs/landing-redesign.json` records 56 passing Chromium checks, covering:

- 320, 360, 390, 430, 768, 1024, 1280 and 1440 px, plus 600, 860 and 900 px.
- Page overflow and visible-heading clipping.
- Navigation menu, Escape/focus return, section anchors below the sticky header, refresh and internal destinations.
- FAQ pointer and keyboard operation, example range controls and the skip link.
- Reduced motion, static and manual workflow exploration, pointer parallax, scroll-linked progress, automatic progression, pause and offscreen suspension.
- A 640 CSS-pixel reflow viewport, equivalent to a 1280-pixel browser viewport at 200% zoom. Native browser zoom was not separately automated.
- No runtime, console or local HTTP errors.

Full desktop/mobile screenshots and hero close-ups were captured and visually inspected; mobile menu and expanded FAQ screenshots are included. Initial visual checks found and corrected symbol encoding, the mobile background crop, headline wrapping, small labels and control target sizes. The browser checks also distinguish intentionally clipped screen-reader text from visible headings.

To reproduce, build and serve the production app with `pnpm --filter @staple/web build` and `pnpm --filter @staple/web preview --host 127.0.0.1 --port 5180 --strictPort`, then run `node web/e2e/landing.mjs`. Override `STAPLE_LANDING_URL` to inspect another local base path.

## Screenshots

- [Desktop, full page](screenshots/landing-redesign-desktop.png)
- [Desktop hero](screenshots/landing-redesign-desktop-hero.png)
- [Mobile, full page](screenshots/landing-redesign-mobile.png)
- [Mobile hero](screenshots/landing-redesign-mobile-hero.png)
- [Mobile menu](screenshots/landing-redesign-mobile-menu.png)
- [Mobile FAQ](screenshots/landing-redesign-mobile-faq.png)

## Scope limits

This is a local implementation. It has not been pushed, merged or deployed. The existing testnet funding/credential, live campaign, independent security review and pilot dependencies remain unchanged and do not block the landing redesign. Browser checks were run in Chromium; cross-engine and physical-device testing remain optional follow-up work. Pre-existing repository changes are outside the redesign commits.
