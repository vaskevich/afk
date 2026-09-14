# Testing

Vitest, one config at the repo root, tests next to the code they cover.

```bash
pnpm test            # everything, once
pnpm test:watch      # watch mode
pnpm vitest run packages/server/src/rules   # one directory
```

The reference test is `packages/server/src/rules/engine.test.ts`. Read it first; the
rules below are what it demonstrates.

## Rules

1. **Co-locate.** `foo.ts` is tested by `foo.test.ts` in the same directory (`.test.tsx`
   for React). No separate `tests/` trees.
2. **Test behaviour through the public surface.** Call the exported function, class, or
   route and assert on what it returns or emits. Never reach into private fields, never
   assert on log output, never test a helper that only exists to serve one caller.
3. **One behaviour per test, named as the sentence it proves.** "opens an event once cpu
   has been above 90% for 30 s" rather than "test cpu rule". `describe` groups by unit
   or feature; `it` states the behaviour.
4. **Explicit time.** Build inputs at fixed offsets from `T0_MS` / `T0_SECONDS` in
   `@afk/shared/testing`. Pass timestamps into the code under test. Reach for
   `vi.useFakeTimers()` only for code that owns a timer (the store ticker, the SSE
   keepalive), and restore it in `afterEach`.
5. **Builders over literals.** `@afk/shared/testing` exports `makeSystemFrame`,
   `makeRunFrame`, `makeStoredFrames`, `makeSessionSummary`, `makeEvent`, `makeHost`.
   Each returns a valid value with boring defaults; override only what the test is
   about. Add a builder there when a shape is needed by more than one package.
6. **Real implementations over mocks.** Use `MemorySessionStorage` instead of mocking
   storage, `app.request()` instead of an HTTP client, the fixture source instead of
   mocking fetch. Mock only true edges (the network, `Date.now` where unavoidable) and
   prefer `vi.spyOn` with `restoreMocks` (already on globally) over module mocks.
7. **Arrange, act, assert, in that order,** separated by a blank line. Assert with
   `toEqual` / `toMatchObject` on whole objects rather than a chain of property checks;
   use `expect.objectContaining` when only part of an object matters.
8. **Deterministic and isolated.** No shared mutable state between tests, no reliance on
   test order, no real files outside a per-test temp directory (`fs.mkdtemp`, removed in
   `afterEach`), no real network, no sleeps.
9. **Failure cases are tests too.** Invalid input, duplicates, empty input, the boundary
   of a threshold (29 s vs 30 s), a rejected write.
10. **Keep them fast.** The whole suite should run in seconds. If a test needs a large
    input, build it in a loop rather than pasting it.

## Per layer

- **shared** (`packages/shared/src`): schemas parse valid input and reject invalid input
  with the field named; enums and constants match what the docs promise.
- **server rules** (`rules/`): pure. Feed stored frames, assert events. Cover thresholds,
  backdating, close, replay vs live parity.
- **server store** (`store/`): `SessionStore` with `MemorySessionStorage`; `DiskSessionStorage`
  against a temp dir; the S3 backend against a small fake client object implementing only
  the commands it uses. Cover de-duplication, write-before-advance, lazy load, hydrate.
- **server routes** (`routes/`, `middleware/`): build the app with
  `createApp(makeAppConfig(overrides), new SessionStore(new MemorySessionStorage()))` and
  call `app.request(path, init)`. `routes/test-helpers.ts` has `makeAppConfig`,
  `createTestSession`, `postFrames` / `postFrameBody`, and `endTestSession`, all sending
  the `X-Afk-Client` header the client-facing routes require (pass `{}` as the headers
  argument to test its absence). For the SSE route read the response body as text with a
  bounded number of events. Cover auth, 410 on ended sessions, 426 on old clients, 413
  at the body limit boundary, NDJSON validation errors naming the line, resume from an
  index.
- **server utils** (`utils/`): small and exhaustive.
- **web** (`packages/web/src`): pure modules first (`timeline/model.ts`, `clusters.ts`,
  `viewport.ts`, `events.ts`, `format.ts`, the fixture generator). Hooks and components
  only where they hold logic; use `// @vitest-environment jsdom` at the top of those files
  and `@testing-library/react` if it is added. Do not test canvas drawing.
- **cli** (`cli/`): source the script with `AFK_SOURCED=1` from a vitest test through
  `child_process` and call functions directly: JSON helpers, `collect_system` output
  validated with the shared Zod schema, the spool rotate and batch logic against a temp
  `AFK_HOME` and a tiny local HTTP server started in the test. Bash 3.2 only.

## What not to do

- Snapshot tests of large objects or rendered markup.
- Tests that pass because they mirror the implementation line by line.
- `any` casts to reach private state; if it is worth testing, it is worth an interface.
- Skipped or `.only` tests left in the tree.
