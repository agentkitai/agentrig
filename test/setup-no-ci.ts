/**
 * Ink checks `is-in-ci` BEFORE it checks whether the frame is too tall (`ink/build/ink.js`,
 * `onRender`) and returns having written only the `<Static>` output. GitHub Actions sets `CI=true`
 * on every step, so under CI — the only place these tests run automatically — the frame-height
 * guards in `packages/cli/test/tui-frame.test.ts` could not fail. Reverting the fix they guard
 * left all four of them green.
 *
 * `is-in-ci` computes its value at module load, so this has to happen before any test file imports
 * Ink: a setup file does, `vi.stubEnv` inside a test does not.
 */
for (const key of Object.keys(process.env)) {
  if (key === "CI" || key === "CONTINUOUS_INTEGRATION" || key.startsWith("CI_")) {
    delete process.env[key];
  }
}
