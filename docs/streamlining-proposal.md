# Streamlining Proposal

> **已收敛**（2026-07-14 起收敛为三 edition：Claude Code / Codex / DeepSeek API——本文其余内容为历史记录）

## Summary

The project should read as:

> one shared core pipeline, one canonical Node runtime, and thin interfaces for Codex, Claude, CLI, and web.

Today the project already has a strong shared `core/`, but the interface/runtime boundaries are starting to blur. The cleanest path is to make the Node runtime canonical, keep Claude as a generated compatibility target, and move model defaults into one source of truth.

## Current Shape

### Shared Core

- `core/`
  - pipeline orchestration
  - prompt builders
  - schemas
  - glossary/entity logic
  - transcript refinement rules

### Runtimes

1. Claude Code Workflow runtime
   - `build/bootstrap-cc.js`
   - generated `claude-code-skill/workflow.js`

2. Universal Node runtime
   - `universal/cli.js`
   - `universal/server.js`
   - `universal/web/`
   - `engines/api.js`
   - `engines/openai.js`

### User-Facing Interfaces

1. Claude skill
   - `claude-code-skill/SKILL.md`

2. Codex skill
   - `codex-skill/latepost-refiner/SKILL.md`

3. CLI
   - `latepost-refiner`
   - compatibility alias: `transcriber`

4. Local web UI
   - `latepost-refiner-web`
   - compatibility alias: `transcriber-web`

## Target Architecture

```text
core/
  pipeline.js
  prompts.js
  spec.js
  meta.js

engines/
  api.js
  openai.js
  providers.js
  model-profiles.js
  fileops.js

runtime/
  cli.js
  server.js
  web/
  jobs.js
  artifacts.js
  launch.command

interfaces/
  codex/
    latepost-refiner/
      SKILL.md
      agents/openai.yaml
      references/
  claude/
    SKILL.md
    references/
    workflow.js
    build-zips.sh

build/
  build-cc.mjs
  bootstrap-cc.js

eval/
docs/
test/
```

## Recommended Changes

### 1. Make The Node Runtime Canonical

Treat the Node runtime as the main execution path.

CLI, web UI, and Codex should all call the same runtime path. Claude should become a packaged/exported compatibility target rather than an equally separate product surface.

Benefits:

- one operational path to test
- fewer divergent docs
- easier model/provider improvements
- simpler mental model for users and contributors

### 2. Rename `universal/` To `runtime/`

`universal/` was useful while proving the standalone edition, but `runtime/` communicates the role more clearly.

Suggested move:

```text
universal/cli.js        -> runtime/cli.js
universal/server.js     -> runtime/server.js
universal/web/          -> runtime/web/
universal/jobs.js       -> runtime/jobs.js
universal/artifacts.js  -> runtime/artifacts.js
universal/launch.command -> runtime/launch.command
```

Keep temporary compatibility bin aliases and update imports in one focused commit.

### 3. Group Interfaces Under `interfaces/`

Move user-facing skill packages into one folder:

```text
claude-code-skill/                  -> interfaces/claude/
codex-skill/latepost-refiner/      -> interfaces/codex/latepost-refiner/
```

This clarifies that these are entry layers, not separate engines.

### 4. Extract `engines/model-profiles.js`

Model defaults currently live across provider registry, web scoring, and skill docs. Create one explicit source:

```js
export const MODEL_PROFILES = {
  openaiDefault: {
    provider: 'openai',
    models: {
      scout: 'gpt-5.4-mini',
      verify: 'gpt-5.4',
      dedup: 'gpt-5.4',
      refine: 'gpt-5.4',
      logic: 'gpt-5.4',
      summary: 'gpt-5.4',
      timeline: 'gpt-5.4',
    },
  },
  openaiPremium: {
    provider: 'openai',
    models: {
      scout: 'gpt-5.4-mini',
      verify: 'gpt-5.4',
      dedup: 'gpt-5.4',
      refine: 'gpt-5.5',
      logic: 'gpt-5.5',
      summary: 'gpt-5.5',
      timeline: 'gpt-5.5',
    },
  },
}
```

Then use it from:

- CLI defaults/help
- web UI defaults
- Codex skill reference
- tests

This is the smallest high-leverage simplification and should happen before folder moves.

### 5. Make Claude Skill Generated Or Mostly Generated

The Claude workflow bundle is already generated. The next step is to reduce duplicated human-maintained instructions.

Possible approach:

- Keep canonical detailed references under `interfaces/shared/` or `docs/reference/`.
- Generate or sync Claude/Codex packaging references from that canonical material.
- Keep platform-specific `SKILL.md` files short and focused on invocation differences.

### 6. Teach One Command Name

Docs should teach only:

```bash
latepost-refiner
latepost-refiner-web
```

Keep these compatibility aliases in `package.json` for now:

```bash
transcriber
transcriber-web
```

Remove them only after users have had time to migrate.

## Migration Plan

### Phase 1: Low-Risk Cleanup

1. Add `engines/model-profiles.js`.
2. Point Codex docs and web/CLI defaults at those profiles.
3. Update tests for model profile selection.
4. Keep all existing paths intact.

### Phase 2: Runtime Rename

1. Move `universal/` to `runtime/`.
2. Update imports, package bins, README, tests, and skills.
3. Keep compatibility shims if needed:

```js
// universal/cli.js
import '../runtime/cli.js'
```

4. Remove shims in a later release.

### Phase 3: Interface Grouping

1. Move Claude and Codex skill packages under `interfaces/`.
2. Update package `files`.
3. Update symlink/install docs.
4. Update CI drift checks.

### Phase 4: Shared Reference Generation

1. Identify duplicated instructions across Claude and Codex skills.
2. Move shared rules into canonical references.
3. Generate platform-specific bundles where practical.

## Risks

- Folder moves can create noisy diffs and break package paths.
- Claude workflow drift checks must be updated carefully.
- Existing user symlinks may point at old skill directories.
- Published package consumers may rely on old `universal/` paths if they import internals.

## Recommendation

Start with `engines/model-profiles.js`.

It removes the most confusing duplication, improves Codex/OpenAI defaults immediately, and does not require a risky repo move. After that lands and tests are green, do the `universal/` to `runtime/` rename as a dedicated commit.
