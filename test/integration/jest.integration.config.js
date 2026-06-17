/**
 * Integration / E2E suite (Phase 10D). Runs the real relay, consumers, and
 * lifecycle worker against real MySQL + RabbitMQ provisioned by Testcontainers.
 *
 * REQUIRES A RUNNING DOCKER DAEMON. Without Docker these specs cannot start.
 *
 * - testMatch is *.int-spec.ts so the unit run (test/**\/*.spec.ts) never picks
 *   these up, and vice-versa.
 * - maxWorkers=1: the containers + constructed services are a single shared
 *   "world" (see ./world.ts); the specs must not run in parallel processes.
 * - long testTimeout: pulling images + first container start can take a while.
 */
/** @type {import('jest').Config} */
module.exports = {
  rootDir: '../..',
  moduleFileExtensions: ['js', 'json', 'ts'],
  testMatch: ['<rootDir>/test/integration/**/*.int-spec.ts'],
  transform: {
    '^.+\\.(t|j)s$': 'ts-jest',
  },
  testEnvironment: 'node',
  testTimeout: 120_000,
  maxWorkers: 1,
}
