# Sidework — Aside-led browser UI

## Current direction (supersedes the historical Chrome-like layout below)

The user explicitly approved the Aside public browser composition. Current source: `src/renderer/aside-shell.css`, with the shared baseline in `styles.css`. The reference is research evidence, not a shipping image or proprietary engine.

- Unified left navigation:228px at widths1100px and above,64px below; top navigation56px; split-pane headers32px. Native content uses exactly those offsets.
- Main surface `#fafdfe`, sidebar `#eaf8fa`, ink `#253438`, secondary ink `#5b6d73`, separators `#dce7e9`; system Korean-readable typography, base13px.
- Central new-tab composer max620px, content740px; compact secondary controls. Real task data only; no invented pins, readiness, previews or completion.
- Ordinary and agent tabs remain distinct. Existing normal browsing does not require AI. Goal-first bootstrap/decomposition and automatic agent-resource allocation remain unfinished broader scope.

## Verified UI-SKILLS polish

Candidate: `release-ui-skills-polish-20261025-01/mac-arm64/Sidework Codex.app`.

-437 tests/typecheck/strict lint/build/package passed; actual native1440px and1000px geometry and ordinary controls passed.
- Vertical ordinary-tab ArrowUp/Down/Home/End navigation, selected-only selector tab stop, actual activation acknowledgement and focus restoration; IME/modifiers are not intercepted.
- Horizontal panel tabs support ArrowLeft/Right/Home/End and control a real labelled flex-scrolling panel.
- Explicit Search/Ask switches preserve drafts and move focus to the actual input; initial render does not steal focus. Mode-specific help uses aria-describedby.
- Selected tab uses weight600 as well as color; inset2px focus outline at offset-2px avoids clipping. Secondary labels11px; actual mode-help contrast5.30:1.
- Composer and compact close targets enlarged; coarse-pointer sidebar/composer minimum44px. Physical touch/screen-reader operation is not claimed tested.
- Existing reduced-motion handling remains; no new animation or library. Disabled blank-goal execution is visibly explained rather than falsely enabled.
- Evidence: `docs/UI-SKILLS-POLISH-VERIFICATION.md`, `qa/aside-shell-native-Qbvnru/`.

## Historical direction contract — not current visual authority

- THESIS: A familiar desktop browser first; AI is an optional companion, not a permanent work console. The user explicitly chose Chrome-like tabs/address bar, webpage-first content and an on-demand sidebar.
- OWN-WORLD: Light cool-neutral browser chrome, system Korean-readable UI type, conventional navigation and tab geometry, restrained blue for AI/focus/active state. Do not copy Chrome branding or imply engine/extension parity.
- STORY: Launch into a full-width new tab, navigate normally, open AI only when needed, close it to recover the entire content area. Keep draft/history/approval state while the panel is hidden.
- FIRST VIEWPORT: Native traffic lights and tabs in the top 48px; navigation/address/profile/history/settings/AI controls in the next 40px. Actual WebContentsView starts at x=0,y=88 and fills the remaining window. No left rail or bottom statusbar.
- FORM: User-pinned conventional desktop browser. No concept roll; the user selected the familiar browser direction explicitly.
- FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance.

## Delivered behavior

- Default sidebar width 0, opened sidebar 380px (360px below 1200px). Renderer and native webview bounds share `browserLayout`.
- Header AI toggle and sidebar close button. Settings/history/profiles use the same optional panel, not a permanent rail.
- Native page focus forwards Cmd/Ctrl+L,T,J to browser controls. No model-controlled keyboard/shell surface added.
- Sidebar close restores the webpage width without clearing the unsent request. Approval requests automatically reopen the correct assistant job, so hiding AI cannot hide a new approval silently.
- New-tab/profile transitions briefly disable the address field until their context is initialized; loading an ordinary webpage does not disable the omnibox.

## UI refinement 0.9.1

- Advanced model/task/batch controls are in a default-closed disclosure; target, prompt, submit and stop remain directly available. No default consent is added.
- Busy-page user takeover is an explicit `직접 사용` action, with acknowledged control status kept separate from cancellation intent.
- Approval allow/deny controls share width, minimum 40px height and 13px text. Targets and job state remain named and bound to current document identity.
- Native floating status banners no longer obscure website controls; phase labels remain in browser chrome. Authorized-input pointer/edge feedback and model-capture exclusions remain.
- Verified candidate: 304 tests/type/lint/build/package, actual two-pane UI operation and ordinary native browsing regression. Actual window recording is 1440×930 / 12.44s / approximately 5 samples/sec, deterministic planner only. See `docs/UI-REFINEMENT-0.9.1-VERIFICATION.md`; real-model sustained parallelism remains incomplete.

## Task-space management 0.10.0

- Optional `작업 공간` switcher in the tab strip opens current visible page tiles without adding permanent chrome. Genuine local previews are requested explicitly, not invented or sent to a model; absent/stale scope shows text.
- Tiles retain exact page/job identity for open, inspect, stop and user takeover. The panel explicitly distinguishes current visible pages from a native isolated background Space engine.
- Full314-test/type/lint/build/package gate, native thumbnail decode/open/inspect/takeover and ordinary browsing pass. A separate actual-model two-pane repeat produced two natural nonzero movement overlaps, with raw and decoded dual-pointer frames; no scheduler/approval/motion-duration weakening.
- Evidence and scope: `docs/TASK-SPACES-0.10.0-VERIFICATION.md`. The native UI remains a scrollable side-panel overview, not a claim of ego engine parity or 4/8-model background autonomy.

## Verification / verdict

- Real MDN and Wikipedia pages, two tabs, full-width native view, open/close/draft preservation, settings and 1100px layout were exercised. Actual OS-window captures include both shell and WebContentsView, not a synthesized composite.
- Browser-first QA 8 PASS in `qa/browser-first-nGq0ON/result.json`.
- Existing live model/action integration QA 10 PASS in `qa/flow-bf9bRc/result.json`, including closing the sidebar during planning and reopening it for approval.
- Source TDD evidence: `qa/browser-first-red.log`, `qa/browser-keyboard-red.log`; final gates have separate browser-first logs.
- No shipping decorative raster or screenshot assets were introduced. QA PNGs are real captures of the app and publicly rendered website content and are not part of the app payload.
