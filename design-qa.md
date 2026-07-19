# Hermes compact redesign — design QA

## Evidence

- Source visual truth path: `/tmp/hermes-design-audit-2026-07-19/02-codex-reference.png`
- Browser-rendered implementation screenshot path: `/tmp/hermes-redesign-1280x720.png`
- Final deterministic implementation screenshot path: `/Users/mohamadsmt/Documents/Hermes UI/tests/e2e/visual.spec.ts-snapshots/desktop-rtl-light-chromium-darwin.png`
- Full-view comparison evidence: `/tmp/hermes-codex-final-dark-comparison.png`
- Viewport: `1280x720`, desktop, RTL, dark, empty conversation for the source-aligned comparison.
- State: connected shell with conversation rail, empty transcript, and compact composer. Hermes intentionally keeps its own purple accent and does not copy Codex's permanent third column.
- Additional responsive evidence:
  - `/Users/mohamadsmt/Documents/Hermes UI/tests/e2e/visual.spec.ts-snapshots/tablet-820x900-rtl-session-drawer-chromium-darwin.png`
  - `/Users/mohamadsmt/Documents/Hermes UI/tests/e2e/visual.spec.ts-snapshots/wide-1440x900-rtl-pinned-inspector-chromium-darwin.png`
  - `/Users/mohamadsmt/Documents/Hermes UI/tests/e2e/visual.spec.ts-snapshots/mobile-rtl-bidi-mobile-darwin.png`
  - `/Users/mohamadsmt/Documents/Hermes UI/tests/e2e/visual.spec.ts-snapshots/workspace-settings-en-mobile-mobile-darwin.png`

Focused-region crops were not needed: the source and implementation captures are native-resolution 1280x720 images, and the additional native-resolution tablet, wide-inspector, and mobile captures make the composer, rails, controls, and text hierarchy readable without resampling.

## Findings

No actionable P0, P1, or P2 findings remain.

- Fonts and typography: Hermes uses Vazirmatn for Persian, Inter for English, and JetBrains Mono for technical strings. The final 14px desktop scale, compact labels, hierarchy, wrapping, and explicit LTR isolation match the reference's practical density while preserving Persian readability.
- Spacing and layout rhythm: the 52px workspace rail, 264px conversation rail, 48px headers, 36px desktop controls, 820px transcript/composer width, and restrained 6/8/12px radii produce the intended compact hierarchy. Mobile targets remain at least 44px.
- Colors and tokens: neutral surfaces, low-contrast dividers, restrained elevation, semantic status colors, and the Hermes purple accent are consistent in light and dark themes. WCAG contrast and target-size checks pass.
- Image quality and asset fidelity: neither product view depends on photographic or branded raster imagery. All interface icons use the existing Lucide library; no placeholder, emoji, CSS-art, or handcrafted SVG substitute was introduced.
- Copy and content: Persian remains the default, English is complete, technical identifiers remain unchanged and isolated LTR, and new navigation, pin, model-settings, and overflow labels are localized.
- Responsiveness: geometry was verified at 320, 360, 479/481, 639/641, 671/673, 831/833, 959/961, 1280, and 1440 widths in RTL and LTR. No page overflow, composer collision, clipping, or persistent-control overlap remains.

## Comparison history

### Pass 1 — blocked

- [P1] Settings produced a hydration mismatch when the resolved theme differed between server and client.
  - Fix: replaced effect-driven mounted state with a hydration-safe external-store snapshot and verified a fresh Settings load with an empty browser console.
  - Post-fix evidence: `/tmp/hermes-redesign-settings-1440.png` and the final Settings snapshots.
- [P2] The mobile Settings theme labels truncated and the chat header exposed two visually similar menu controls.
  - Fix: tightened the mobile theme-option layout, hid redundant check decoration at the narrowest width, and changed the conversation-panel icon to a distinct panel affordance.
  - Post-fix evidence: `/Users/mohamadsmt/Documents/Hermes UI/tests/e2e/visual.spec.ts-snapshots/workspace-settings-en-mobile-mobile-darwin.png`.
- [P2] Persistent mobile message action labels made the transcript feel crowded.
  - Fix: kept the actions accessible by name while rendering them as compact icon controls on mobile.
  - Post-fix evidence: `/Users/mohamadsmt/Documents/Hermes UI/tests/e2e/visual.spec.ts-snapshots/mobile-rtl-bidi-mobile-darwin.png`.

### Pass 2 — blocked

- [P1] The conversation-rail collapse control was partially obscured by the mobile workspace-navigation trigger when the drawer was open.
  - Fix: removed the desktop-only collapse affordance from drawer mode; the dedicated close action remains available.
  - Post-fix evidence: `/Users/mohamadsmt/Documents/Hermes UI/tests/e2e/visual.spec.ts-snapshots/tablet-820x900-rtl-session-drawer-chromium-darwin.png`; Axe reports zero violations in the drawer state.
- [P1] An open overlay inspector covered the chat-header overflow, making its pin action unreachable.
  - Fix: added a localized pin/unpin action directly to both artifact and workspace-file inspector headers.
  - Post-fix evidence: `/Users/mohamadsmt/Documents/Hermes UI/tests/e2e/visual.spec.ts-snapshots/wide-1440x900-rtl-pinned-inspector-chromium-darwin.png`.

### Pass 3 — passed

- The final 1280x720 same-state comparison confirms comparable density, hierarchy, rail proportions, compact composer treatment, and neutral surfaces without copying Codex's permanent three-column layout.
- Tablet and mobile captures confirm drawer behavior, 44px touch targets, readable BiDi content, and the absence of the old bottom navigation.
- The wide capture confirms a 320px pinned inspector while preserving more than 680px for chat.
- Primary interactions tested: workspace navigation drawer, conversation drawer and collapse persistence, composer model/profile/reasoning settings, header overflow, inspector pin/unpin and resize, queue, approval, Escape, focus restoration, and theme switching.
- Console errors checked: fresh chat and Settings routes returned no browser console errors after the hydration fix.

## Follow-up polish

- P3: a future branded illustration could enrich the empty state, but it is intentionally excluded because neither the source nor Hermes currently provides an approved asset.

final result: passed
