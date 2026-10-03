// peerDependencies may only promise what CI tests: the lower bound of each
// range must be the version installed here (the one the suite runs against).
import { readFileSync } from 'fs';
import { join } from 'path';

const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
const installed = (name: string) =>
  JSON.parse(readFileSync(join(__dirname, '..', 'node_modules', name, 'package.json'), 'utf8')).version as string;

it('@prisma/client peer starts at the tested version', () => {
  expect(pkg.peerDependencies['@prisma/client']).toBe(`^${installed('@prisma/client')}`);
});

it('rxjs peer is limited to the tested major', () => {
  const major = installed('rxjs').split('.')[0];
  expect(pkg.peerDependencies.rxjs).toBe(`^${major}`);
});

it('NestJS peers list exactly the CI matrix majors (11 and 12)', () => {
  const ci = readFileSync(join(__dirname, '..', '.github', 'workflows', 'ci.yml'), 'utf8');
  const majors = [...ci.matchAll(/^\s*nest: (\d+)/gm)].map((m) => m[1]).sort();
  const range = majors.map((m) => `^${m}.0.0`).join(' || ');
  expect(pkg.peerDependencies['@nestjs/common']).toBe(range);
  expect(pkg.peerDependencies['@nestjs/core']).toBe(range);
});
