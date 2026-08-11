/**
 * LIVE Midtrans Sandbox suite (Phase 5H.2 §13).
 *
 * Separate from the integration config on purpose: these specs make REAL HTTPS
 * calls to the Midtrans Sandbox Core API, so a normal `pnpm test` or
 * `pnpm test:integration` run must never trigger them. Run deliberately:
 *
 *   pnpm test:sandbox
 *
 * Requires Docker (Testcontainers) AND sandbox credentials in the environment;
 * the specs refuse to run unless the resolved config is a sandbox environment.
 */
/** @type {import('jest').Config} */
module.exports = {
  rootDir: '../..',
  moduleFileExtensions: ['js', 'json', 'ts'],
  testMatch: ['<rootDir>/test/integration/**/*.live-spec.ts'],
  transform: { '^.+\.(t|j)s$': 'ts-jest' },
  testEnvironment: 'node',
  testTimeout: 180_000,
  maxWorkers: 1,
}
