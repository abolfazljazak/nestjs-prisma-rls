// Smoke test of the PUBLISHED artifact, not the source: npm pack, install the
// tarball into a fresh project, then require it, import it and type-check it.
// Run with `npm run test:pack` (after `npm run build`).
import { execSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const root = resolve(__dirname, '..');
const run = (cmd: string, cwd: string) => execSync(cmd, { cwd, stdio: 'pipe', encoding: 'utf8' });

const expected = [
  'runWithTenant', 'getTenantId', 'MissingTenantError', 'TenantSwitchError', 'prismaRlsExtension',
  'PrismaRlsModule', 'PrismaRlsInterceptor', 'InjectPrismaRls', 'PRISMA_RLS_CLIENT',
  'PrismaRlsAdminModule', 'InjectPrismaRlsAdmin', 'PRISMA_RLS_ADMIN_CLIENT',
  'checkPrismaRlsSetup', 'checkPrismaRlsAdminSetup',
].sort();

const dir = mkdtempSync(join(tmpdir(), 'nestjs-prisma-rls-smoke-'));
try {
  // 1. Pack exactly what `npm publish` would upload.
  const [packed] = JSON.parse(run(`npm pack --json --pack-destination "${dir}"`, root));
  const files: string[] = packed.files.map((f: { path: string }) => f.path).sort();
  const unexpected = files.filter((f) => !/^(dist\/.+\.(js|d\.ts)|package\.json|README\.md|LICENSE)$/.test(f));
  if (unexpected.length) throw new Error(`Unexpected files in the package: ${unexpected.join(', ')}`);
  console.log(`packed ${packed.filename}: ${files.length} files`);

  // 2. Fresh consumer project. Peers come from this repo's versions.
  const pkg = require(join(root, 'package.json'));
  const dev = pkg.devDependencies;
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'smoke', private: true }));
  run(
    `npm install --no-audit --no-fund --prefer-offline "${join(dir, packed.filename)}" ` +
      `@nestjs/common@${dev['@nestjs/common']} @nestjs/core@${dev['@nestjs/core']} ` +
      `@prisma/client@${dev['@prisma/client']} rxjs@${dev.rxjs} reflect-metadata typescript@${dev.typescript} @types/node`,
    dir,
  );

  // 3. CommonJS require: the published entry point and every public export.
  const cjs = run(`node -e "console.log(JSON.stringify(Object.keys(require('nestjs-prisma-rls')).sort()))"`, dir).trim();
  if (cjs !== JSON.stringify(expected)) throw new Error(`require() exports differ:\n${cjs}\nexpected:\n${JSON.stringify(expected)}`);
  console.log('require(): ok');

  // 4. ESM import of the CommonJS package.
  run(`node --input-type=module -e "import { PrismaRlsModule } from 'nestjs-prisma-rls'; if (!PrismaRlsModule) process.exit(1)"`, dir);
  console.log('import: ok');

  // 5. Internals must not be importable (exports field).
  try {
    run(`node -e "require('nestjs-prisma-rls/dist/context')"`, dir);
    throw new Error('deep import of dist/context should fail');
  } catch (err) {
    if (!String((err as { stderr?: string }).stderr).includes('ERR_PACKAGE_PATH_NOT_EXPORTED')) throw err;
  }
  console.log('internals hidden: ok');

  // 6. Types resolve from the published .d.ts files.
  writeFileSync(
    join(dir, 'check.ts'),
    `import { PrismaRlsModule, runWithTenant, MissingTenantError } from 'nestjs-prisma-rls';
     const m = PrismaRlsModule.forRoot({ tenantFrom: (req: any) => req.user?.tenantId, client: () => ({} as any) });
     const n: number = runWithTenant('t', () => 1);
     const e: Error = new MissingTenantError();
     void m; void n; void e;`,
  );
  run(`npx tsc --noEmit --strict --skipLibCheck --experimentalDecorators --module node16 --moduleResolution node16 check.ts`, dir);
  console.log('types: ok');
  console.log('pack smoke test passed');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
