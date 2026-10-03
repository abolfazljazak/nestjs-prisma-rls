# Release checklist

Publishing to npm is public and effectively permanent (a version can't be
unpublished after 72 hours, and its number can never be reused). The
maintainer runs every publish step by hand.

## 1. Code and tests

- [ ] `main` is clean: `git status` shows nothing to commit.
- [ ] Local Postgres is up: `npm run db:up`.
- [ ] Types: `npx tsc --noEmit -p tsconfig.json`
- [ ] Tests: `npm test` (all pass).
- [ ] Published artifact: `npm run test:pack` (pack, install, require/import/types).
- [ ] CI is green on GitHub for the commit being released, **every matrix job**
      (Node 22 / NestJS 11 and Node 24 / NestJS 12).
- [ ] `peerDependencies` and `engines` list only versions covered by CI.

## 2. Version and docs

- [ ] `version` in `package.json` is the one to release (first release: `0.1.0`).
- [ ] `CHANGELOG.md`: the version's section has a date instead of "unreleased".
- [ ] README: "Supported versions" matches the CI matrix; the early-release note is still accurate.
- [ ] Optional: re-run `npm run bench` and update the Performance section if the hook changed.

## 3. Review exactly what will be uploaded

```bash
npm publish --dry-run
```

- [ ] The file list is only `dist/*.js`, `dist/*.d.ts`, `package.json`, `README.md`, `LICENSE`.
- [ ] No tests, `.env`, `bench/`, `scripts/`, source maps or stale files from renamed modules.
- [ ] Package name `nestjs-prisma-rls` and the version are correct.

## 4. Publish (maintainer only)

- [ ] Logged in to the right npm account: `npm whoami`.
- [ ] 2FA is enabled on the npm account.
- [ ] `npm publish` (runs `prepublishOnly` → clean build).
- [ ] Check https://www.npmjs.com/package/nestjs-prisma-rls shows the version and README.

## 5. After publishing

- [ ] Tag and push: `git tag v0.1.0 && git push origin v0.1.0`.
- [ ] Create a GitHub release from the tag with the CHANGELOG section.
- [ ] Install the published version in a scratch project once: `npm install nestjs-prisma-rls`.
