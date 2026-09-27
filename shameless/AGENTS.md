# SHAMELESS — engineering conventions (read before touching code)

Browser FPS in Three.js (r186) + TypeScript + Vite. Physics: Rapier (`@dimforge/rapier3d-compat`).
Post-processing: `postprocessing` (pmndrs) is installed; three's own `three/examples/jsm` addons are available too.

## Hard rules
- **No external assets.** The network blocks asset hosts. Every texture, model, animation, sound, and HDRI is
  generated procedurally (GPU shaders into render targets, canvas, geometry code, WebAudio synthesis).
  npm packages are fine (`npm i` works) — tell the orchestrator if you add one.
- **Own only your folder.** Each workstream owns `src/<module>/**` and `src/dev/scenes/<module>*.ts`.
  Never edit another module's files. `src/core/**` and `src/main.ts` belong to the orchestrator — if a
  contract in `src/core/types.ts` or an event in `src/core/events.ts` must change, report it in your final
  message (exact diff) instead of editing.
- Several agents edit this tree **at the same time**. Other modules may be mid-change; if something outside
  your folder breaks, work around it in your dev scene and report it. Never `git commit`, `git stash`,
  `git checkout`, or `git reset` — the orchestrator commits.
- `npx tsc --noEmit` must pass for your files before you report done.
- Keep a 60 fps budget on a mid-range discrete GPU at 1080p (the container has no GPU; SwiftShader
  screenshots are slow — that is expected, don't optimize for SwiftShader).

## Module API
Every module exports one factory used by `src/core/Game.ts`:
`createMaterialLibrary()`, `createRenderPipeline(ctx)`, `createPhysics(ctx)`, `createWorld(ctx)`,
`createPlayer(ctx)`, `createWeaponSystem(ctx)`, `createEnemyManager(ctx, {count})`, `createFX(ctx)`,
`createAudio(ctx)`, `createHUD(ctx, uiRoot)`. Contracts: `src/core/types.ts`. Events: `src/core/events.ts`
(typed bus `ctx.events.emit/on`). Construction order is in `createGame()`; during construction a module
may only use ctx fields built before it; at `update()` time everything exists.

## Running & screenshots
- Dev server on your assigned port: `cd shameless && PORT=<port> npx vite > /tmp/vite-<port>.log 2>&1 &`
- Full game in test mode: `/?shot=1` (no menu/pointer lock). `&noenemies`, `&q=0..3` quality tier.
- Isolated dev scenes: `/?scene=<name>` loads `src/dev/scenes/<name>.ts`, whose default export is
  `async (container, uiRoot) => void`. It must set `window.__shameless.ready = true` and increment
  `window.__shameless.frame` each rendered frame (see `src/dev/scenes/example.ts`). You can build a full
  game via `createGame()` in a dev scene and then pose the camera/player, or build a minimal scene.
- Screenshot: `node tools/shot.mjs --port <port> --path "/?scene=<name>" --out shots/<module>/x.png [--frames 30] [--size 1600x900] [--fixed 0.016] [--step "<js>" --out b.png ...]`.
  `--step` runs JS in the page (use `window.__shameless.ctx` / `.api`) before the next `--out`. Page console
  errors are printed. Look at every PNG you produce with the Read tool — never assume a render is right.
- Put screenshots in `shots/<module>/` (git-ignored).

## Quality bar
The target is the look and feel of current Call of Duty (Modern Warfare III / Black Ops 6): physically based
materials with micro-detail and wear, filmic grading, crisp anti-aliased image, heavy weapon feel. Judge your
own screenshots harshly and iterate. An independent critic agent will review your work from screenshots and
send findings back; expect several rounds.
