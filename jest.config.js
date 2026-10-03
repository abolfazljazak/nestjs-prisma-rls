/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  globalSetup: '<rootDir>/test/global-setup.ts',
  roots: ['<rootDir>/test'],
  // Test files share one database and TRUNCATE it: run them one at a time.
  maxWorkers: 1,
};
