// Benchmark: what does nestjs-prisma-rls cost per query?  Run with `npm run bench`.
// Uses the local test database only. Results go to bench/results.md.
import { writeFileSync } from 'fs';
import { cpus, totalmem } from 'os';
import { join } from 'path';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { prismaRlsExtension, runWithTenant } from '../src';
import { assertTestDatabase } from '../test/global-setup';
import { PrismaClient } from '../test/prisma/generated/client';

const DB = 'localhost:54329/rowguard_prisma';
const RUNS = 3; // each scenario runs 3 times to see run-to-run variance
const WARMUP = 200;
const ITERATIONS = 2000;
const TX_SIZE = 10; // queries per user transaction in scenario D
const POOL_SIZE = 10;
const CONCURRENCY = 50;
const THROUGHPUT_MS = 3000;
const TENANTS = 100;
const NOTES_PER_TENANT = 1000;

assertTestDatabase(`postgresql://postgres:postgres@${DB}`);

// --- clients ---------------------------------------------------------------

// Counts every statement actually sent to Postgres (Prisma's own query log
// omits BEGIN, so it can't be used to count round trips).
let statements = 0;
function countingPool(user: string) {
  const pool = new Pool({ connectionString: `postgresql://${user}:${user}@${DB}`, max: POOL_SIZE });
  pool.on('connect', (client) => {
    const query = client.query.bind(client) as (...args: unknown[]) => unknown;
    (client as unknown as { query: unknown }).query = (...args: unknown[]) => {
      statements++;
      return query(...args);
    };
  });
  return pool;
}
const client = (user: string) => new PrismaClient({ adapter: new PrismaPg(countingPool(user)) });

const owner = client('postgres'); // superuser: seeding, and the write baseline
const admin = client('rowguard_admin'); // BYPASSRLS: read baseline without RLS
const base = client('app_user');
const prisma = base.$extends(prismaRlsExtension());

// --- data ------------------------------------------------------------------

const tenantId = (n: number) => `bbbbbbbb-0000-0000-0000-${n.toString(16).padStart(12, '0')}`;
const T = tenantId(1);
let ids: number[] = [];
let cursor = 0;
const nextId = () => ids[cursor++ % ids.length];

async function seed() {
  await owner.$executeRaw`TRUNCATE "Comment", "Note" RESTART IDENTITY CASCADE`;
  for (let n = 1; n <= TENANTS; n++) {
    await owner.$executeRaw`INSERT INTO "Tenant" (id, name) VALUES (${tenantId(n)}::uuid, ${`bench-${n}`}) ON CONFLICT DO NOTHING`;
  }
  await owner.$executeRaw`
    INSERT INTO "Note" ("tenantId", title)
    SELECT t.id, 'note ' || g FROM generate_series(1, ${NOTES_PER_TENANT}) g,
         (SELECT id FROM "Tenant" WHERE name LIKE 'bench-%') t`;
  await owner.$executeRaw`ANALYZE "Note"`;
  ids = (await owner.note.findMany({ where: { tenantId: T }, select: { id: true } })).map((n) => n.id);
}

// --- measuring ---------------------------------------------------------------

interface Run {
  p50: number;
  p95: number;
  mean: number;
  statementsPerOp: number;
}

const ms = (ns: bigint) => Number(ns) / 1e6;
const pct = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];

// `fn` performs `ops` operations; each sample is the time per operation.
async function measure(fn: () => Promise<unknown>, ops = 1): Promise<Run> {
  for (let i = 0; i < WARMUP; i++) await fn();
  statements = 0;
  const samples: number[] = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const start = process.hrtime.bigint();
    await fn();
    samples.push(ms(process.hrtime.bigint() - start) / ops);
  }
  const statementsPerOp = statements / (ITERATIONS * ops);
  samples.sort((a, b) => a - b);
  const mean = samples.reduce((s, x) => s + x, 0) / samples.length;
  return { p50: pct(samples, 0.5), p95: pct(samples, 0.95), mean, statementsPerOp };
}

// B: RLS cost alone. One transaction, one set_config, then plain queries in it.
async function measureRlsOnly(): Promise<Run> {
  let run!: Run;
  await base.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${T}, true)`;
      run = await measure(() => tx.note.findUnique({ where: { id: nextId() } }));
    },
    { timeout: 120_000 },
  );
  return run;
}

const inTenant = <R>(fn: () => Promise<R>) => runWithTenant(T, fn);
let titleN = 0;
const title = () => `bench ${titleN++}`;

const scenarios: { name: string; what: string; run: () => Promise<Run> }[] = [
  { name: 'A-read', what: 'plain Prisma, BYPASSRLS role, no transaction', run: () => measure(() => admin.note.findUnique({ where: { id: nextId() } })) },
  { name: 'B-read', what: 'RLS only: queries inside one transaction with one set_config', run: measureRlsOnly },
  { name: 'C-read', what: 'nestjs-prisma-rls, one query per call', run: () => measure(() => inTenant(() => prisma.note.findUnique({ where: { id: nextId() } }))) },
  {
    name: 'D-read',
    what: `nestjs-prisma-rls, ${TX_SIZE} queries per user $transaction (per query)`,
    run: () =>
      measure(
        () =>
          inTenant(() =>
            prisma.$transaction(async (tx) => {
              for (let i = 0; i < TX_SIZE; i++) await tx.note.findUnique({ where: { id: nextId() } });
            }),
          ),
        TX_SIZE,
      ),
  },
  { name: 'A-write', what: 'plain Prisma create, superuser, explicit tenantId', run: () => measure(() => owner.note.create({ data: { tenantId: T, title: title() } })) },
  { name: 'C-write', what: 'nestjs-prisma-rls create (dbgenerated default + WITH CHECK)', run: () => measure(() => inTenant(() => prisma.note.create({ data: { title: title() } }))) },
  {
    name: 'D-write',
    what: `nestjs-prisma-rls, ${TX_SIZE} creates per user $transaction (per create)`,
    run: () =>
      measure(
        () =>
          inTenant(() =>
            prisma.$transaction(async (tx) => {
              for (let i = 0; i < TX_SIZE; i++) await tx.note.create({ data: { title: title() } });
            }),
          ),
        TX_SIZE,
      ),
  },
];

// Throughput under load: CONCURRENCY workers sharing a pool of POOL_SIZE.
async function throughput(fn: () => Promise<unknown>, ops = 1) {
  let done = 0;
  const deadline = Date.now() + THROUGHPUT_MS;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (Date.now() < deadline) {
        await fn();
        done += ops;
      }
    }),
  );
  return done / (THROUGHPUT_MS / 1000);
}

// --- index check -------------------------------------------------------------

async function explain(sql: string): Promise<string> {
  // As app_user with the tenant set, in a transaction that is rolled back.
  return base.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${T}, true)`;
    const rows = await tx.$queryRawUnsafe<{ 'QUERY PLAN': string }[]>(`EXPLAIN ${sql}`);
    return rows.map((r) => r['QUERY PLAN']).join('\n');
  });
}

async function indexCheck() {
  const good = await explain(`SELECT * FROM "Note"`);
  // Same data, but the policy casts the COLUMN instead of the setting.
  await owner.$executeRawUnsafe(`DROP SCHEMA IF EXISTS bench CASCADE`);
  await owner.$executeRawUnsafe(`CREATE SCHEMA bench`);
  await owner.$executeRawUnsafe(`CREATE TABLE bench."Note" AS SELECT * FROM public."Note"`);
  await owner.$executeRawUnsafe(`CREATE INDEX ON bench."Note" ("tenantId")`);
  await owner.$executeRawUnsafe(`ALTER TABLE bench."Note" ENABLE ROW LEVEL SECURITY`);
  await owner.$executeRawUnsafe(
    `CREATE POLICY p ON bench."Note" USING ("tenantId"::text = current_setting('app.tenant_id', true))`,
  );
  await owner.$executeRawUnsafe(`GRANT USAGE ON SCHEMA bench TO app_user`);
  await owner.$executeRawUnsafe(`GRANT SELECT ON bench."Note" TO app_user`);
  await owner.$executeRawUnsafe(`ANALYZE bench."Note"`);
  const bad = await explain(`SELECT * FROM bench."Note"`);
  await owner.$executeRawUnsafe(`DROP SCHEMA bench CASCADE`);
  return { good, bad };
}

// --- report ------------------------------------------------------------------

const f = (x: number) => x.toFixed(3);
const avg = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;

async function main() {
  console.log('Seeding...');
  await seed();
  const [{ version }] = await owner.$queryRaw<{ version: string }[]>`SELECT version()`;

  const results: Record<string, Run[]> = {};
  for (const s of scenarios) {
    results[s.name] = [];
    for (let r = 1; r <= RUNS; r++) {
      process.stdout.write(`${s.name} run ${r}/${RUNS}... `);
      const run = await s.run();
      results[s.name].push(run);
      console.log(`p50 ${f(run.p50)} ms`);
    }
  }

  console.log('Throughput...');
  const tp = {
    'A-read': await throughput(() => admin.note.findUnique({ where: { id: nextId() } })),
    'C-read': await throughput(() => inTenant(() => prisma.note.findUnique({ where: { id: nextId() } }))),
    'D-read': await throughput(
      () =>
        inTenant(() =>
          prisma.$transaction(async (tx) => {
            for (let i = 0; i < TX_SIZE; i++) await tx.note.findUnique({ where: { id: nextId() } });
          }),
        ),
      TX_SIZE,
    ),
  };

  console.log('Index check...');
  const plans = await indexCheck();

  // Summary per scenario: mean of the run p50s, and spread = max - min of them.
  const summary = Object.fromEntries(
    scenarios.map((s) => {
      const p50s = results[s.name].map((r) => r.p50);
      return [s.name, { p50s, p50: avg(p50s), spread: Math.max(...p50s) - Math.min(...p50s), p95: avg(results[s.name].map((r) => r.p95)), stmts: results[s.name][0].statementsPerOp }];
    }),
  );

  const compare = (a: string, b: string) => {
    const diff = summary[b].p50 - summary[a].p50;
    const noise = Math.max(summary[a].spread, summary[b].spread);
    const verdict = Math.abs(diff) > noise ? 'larger than run-to-run variance' : '**within run-to-run variance: not meaningful**';
    return `| ${b} vs ${a} | ${diff >= 0 ? '+' : ''}${f(diff)} ms | ${f(noise)} ms | ${verdict} |`;
  };

  const md = [
    '# nestjs-prisma-rls benchmark results',
    '',
    `- Date: ${new Date().toISOString().slice(0, 10)}`,
    `- Machine: ${cpus()[0].model}, ${cpus().length} threads, ${Math.round(totalmem() / 2 ** 30)} GB RAM`,
    `- Node ${process.version}; ${version.split(',')[0]} in Docker on localhost`,
    `- Data: ${TENANTS} tenants x ${NOTES_PER_TENANT} notes; ${ITERATIONS} iterations after ${WARMUP} warmup; ${RUNS} runs per scenario`,
    '- **Localhost: network round trips are far cheaper here than to a real database server.**',
    '',
    '## Latency per operation (sequential)',
    '',
    '| Scenario | What | p50 per run (ms) | p50 mean (ms) | spread (ms) | p95 mean (ms) | statements/op |',
    '|---|---|---|---|---|---|---|',
    ...scenarios.map((s) => {
      const x = summary[s.name];
      return `| ${s.name} | ${s.what} | ${x.p50s.map(f).join(' / ')} | ${f(x.p50)} | ${f(x.spread)} | ${f(x.p95)} | ${x.stmts.toFixed(1)} |`;
    }),
    '',
    'spread = max - min of the 3 run p50s.',
    '',
    '## Differences vs. baseline',
    '',
    '| Comparison | p50 difference | noise (max spread) | Verdict |',
    '|---|---|---|---|',
    compare('A-read', 'B-read'),
    compare('A-read', 'C-read'),
    compare('A-read', 'D-read'),
    compare('A-write', 'C-write'),
    compare('A-write', 'D-write'),
    '',
    `## Throughput (${CONCURRENCY} concurrent workers, pool of ${POOL_SIZE}, ${THROUGHPUT_MS / 1000} s)`,
    '',
    '| Scenario | queries/s |',
    '|---|---|',
    ...Object.entries(tp).map(([k, v]) => `| ${k} | ${Math.round(v)} |`),
    '',
    '## Index use with the RLS policy',
    '',
    'Policy casting the setting (nestjs-prisma-rls README form):',
    '```',
    plans.good,
    '```',
    'Policy casting the column (`"tenantId"::text = current_setting(...)`):',
    '```',
    plans.bad,
    '```',
    '',
  ].join('\n');

  writeFileSync(join(__dirname, 'results.md'), md);
  console.log('\n' + md);

  await owner.$executeRaw`TRUNCATE "Comment", "Note" RESTART IDENTITY CASCADE`;
  await owner.$executeRaw`DELETE FROM "Tenant" WHERE name LIKE 'bench-%'`;
  await Promise.all([owner, admin, base].map((c) => c.$disconnect()));
}

main().catch(async (err) => {
  console.error(err);
  process.exit(1);
});
