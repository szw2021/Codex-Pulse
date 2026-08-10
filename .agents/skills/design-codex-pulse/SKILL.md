---
name: design-codex-pulse
description: Product and UI design rules for the Codex Pulse macOS menu-bar app. Use only inside the Codex-Pulse repository when changing layout, information hierarchy, session cards, filters, settings, themes, preview panels, window sizing, hover states, or any interaction that affects what the user notices first.
---

# Design Codex Pulse

Design Codex Pulse as a compact attention console for Codex CLI sessions, not as a full chat client or a generic dashboard.

## Preserve the product position

- Help the user notice what is running, what just finished, and what failed.
- Keep the attention order: waiting/active, newly completed, failed, then history.
- Treat local and remote sessions as one list. Keep remote-server management in the top-right menu.
- Prefer useful state and the latest user prompt over decorative metadata.
- Keep the app small, dense, calm, and native to macOS.

## Apply the visual rules

- Use compact spacing and short labels. Remove controls or text that do not change a decision.
- Keep every session item as an independent rounded card.
- Never let hover actions, acknowledgement controls, or state changes increase item height.
- Prevent action buttons from overlapping; preserve reliable click targets at all densities.
- Support light, dark, and system themes with equivalent contrast and hierarchy.
- Preserve the transparent rounded window without any visible rectangular backing layer.
- Avoid selectable interface text except in inputs or content intended for copying.
- Allow one-line or two-line titles without changing the meaning of the layout.

## Design session details

- Open details from the session card without turning the main list into a large interface.
- Show the latest turn's real execution flow when available: prompt, progress, commands, file changes, tools, images, context handling, failures, and final response.
- Keep the action area reachable while the activity timeline scrolls.
- Use color as a secondary status signal, never as the only signal.

## Evaluate a change

1. Identify which user decision becomes faster.
2. Check the result in focus, running, newly completed, failed, and history views.
3. Check both title-line settings and all three themes.
4. Verify hover, acknowledgement, context-menu, preview, pin, minimize, and drag behavior.
5. Reject additions that make the window larger without improving attention or actionability.

Do not apply this skill outside Codex Pulse.
