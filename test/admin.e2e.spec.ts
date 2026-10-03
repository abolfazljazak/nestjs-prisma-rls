// Admin (bypass) client: a separate connection as a BYPASSRLS role.
import 'reflect-metadata';
import { CanActivate, Controller, ExecutionContext, Get, INestApplication, Injectable, Patch } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { PrismaPg } from '@prisma/adapter-pg';
import request from 'supertest';
import {
  InjectPrismaRls,
  InjectPrismaRlsAdmin,
  prismaRlsExtension,
  PrismaRlsAdminModule,
  PrismaRlsModule,
  runWithTenant,
} from '../src';
import { createTestTenants, deleteTenantData, dropTestTenants } from './helpers';
import { PrismaClient } from './prisma/generated/client';

const DB = 'localhost:54329/rowguard_prisma';
// Random per file (see helpers.ts), so files can run in parallel.
let TENANT_A: string;
let TENANT_B: string;

// Same convention as the README: separate env variables for the two roles.
const DATABASE_URL = process.env.DATABASE_URL_APP ?? `postgresql://app_user:app_user@${DB}`;
const PRISMA_RLS_ADMIN_DATABASE_URL =
  process.env.PRISMA_RLS_ADMIN_DATABASE_URL ?? `postgresql://rowguard_admin:rowguard_admin@${DB}`;

const owner = new PrismaClient({
  adapter: new PrismaPg({ connectionString: `postgresql://postgres:postgres@${DB}` }),
});
const newAdminClient = () => new PrismaClient({ adapter: new PrismaPg({ connectionString: PRISMA_RLS_ADMIN_DATABASE_URL }) });

const extend = (c: PrismaClient) => c.$extends(prismaRlsExtension());
type AppPrisma = ReturnType<typeof extend>;

beforeAll(async () => {
  [TENANT_A, TENANT_B] = await createTestTenants(owner, 'admin');
});

beforeEach(async () => {
  // As the superuser (table owner), not app_user: RLS would hide rows from app_user.
  await deleteTenantData(owner, [TENANT_A, TENANT_B]);
  await owner.note.createMany({
    data: [
      { tenantId: TENANT_A, title: 'a1' },
      { tenantId: TENANT_B, title: 'b1' },
    ],
  });
});

afterAll(async () => {
  await dropTestTenants(owner, [TENANT_A, TENANT_B]);
  await owner.$disconnect();
});

// The admin client sees every tenant, including other test files' data:
// always count only this file's tenants.
const ownTenants = () => ({ where: { tenantId: { in: [TENANT_A, TENANT_B] } } });

describe('admin client (no Nest)', () => {
  const adminDb = newAdminClient();
  afterAll(() => adminDb.$disconnect());

  it('sees every tenant, without any tenant context', async () => {
    expect(await adminDb.note.count(ownTenants())).toBe(2);
  });

  it('works inside a tenant context (no TenantSwitchError, no filtering)', async () => {
    expect(await runWithTenant(TENANT_A, () => adminDb.note.count(ownTenants()))).toBe(2);
  });

  it('is still limited by GRANTs: BYPASSRLS skips policies, not privileges', async () => {
    await expect(adminDb.note.deleteMany(ownTenants())).rejects.toThrow(/permission denied|denied/i);
    expect(await owner.note.count(ownTenants())).toBe(2);
  });
});

// Stand-in for a real AuthGuard.
@Injectable()
class FakeAuthGuard implements CanActivate {
  canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest();
    const tenantId = req.headers['x-test-tenant'];
    if (tenantId !== undefined) req.user = { tenantId };
    return true;
  }
}

@Controller()
class ReportController {
  constructor(
    @InjectPrismaRls() private readonly prisma: AppPrisma,
    @InjectPrismaRlsAdmin() private readonly adminDb: PrismaClient,
  ) {}

  @Get('report')
  async report() {
    // Same request, same tenant context: the two clients see different data.
    return { mine: await this.prisma.note.count(), all: await this.adminDb.note.count(ownTenants()) };
  }

  @Patch('rename-all')
  renameAll() {
    return this.adminDb.note.updateMany({ ...ownTenants(), data: { title: 'renamed' } });
  }
}

describe('PrismaRlsAdminModule (Nest)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        PrismaRlsModule.forRoot({
          tenantFrom: (req) => req.user?.tenantId,
          client: () => new PrismaClient({ adapter: new PrismaPg({ connectionString: DATABASE_URL }) }),
        }),
        PrismaRlsAdminModule.forRoot({ client: newAdminClient }),
      ],
      controllers: [ReportController],
      providers: [{ provide: APP_GUARD, useClass: FakeAuthGuard }],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0);
  });

  afterAll(() => app.close());

  it('inside a tenant request: normal client is filtered, admin client sees all', async () => {
    const res = await request(app.getHttpServer()).get('/report').set('x-test-tenant', TENANT_A).expect(200);
    expect(res.body).toEqual({ mine: 1, all: 2 });
  });

  it('admin client can update across tenants (granted)', async () => {
    const res = await request(app.getHttpServer()).patch('/rename-all').set('x-test-tenant', TENANT_A).expect(200);
    expect(res.body).toEqual({ count: 2 });
  });
});

it('without PrismaRlsAdminModule, injecting the admin client fails at boot', async () => {
  await expect(
    Test.createTestingModule({
      imports: [
        PrismaRlsModule.forRoot({
          tenantFrom: (req) => req.user?.tenantId,
          client: () => new PrismaClient({ adapter: new PrismaPg({ connectionString: DATABASE_URL }) }),
        }),
      ],
      controllers: [ReportController],
    }).compile(),
  ).rejects.toThrow(/PRISMA_RLS_ADMIN_CLIENT|resolve dependencies/);
});
