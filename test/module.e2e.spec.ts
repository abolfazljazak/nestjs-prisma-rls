// End-to-end: a small Nest app using RowguardModule, called over HTTP.
import 'reflect-metadata';
import {
  CanActivate,
  Controller,
  ExecutionContext,
  Get,
  INestApplication,
  Injectable,
  Module,
  Post,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { PrismaPg } from '@prisma/adapter-pg';
import { defer, Observable } from 'rxjs';
import request from 'supertest';
import { setTimeout as sleep } from 'timers/promises';
import { InjectRowguard, rowguardExtension, ROWGUARD_CLIENT, RowguardModule, RowguardModuleOptions } from '../src';
import { PrismaClient } from './prisma/generated/client';

const DB = 'localhost:54329/rowguard_prisma';
const TENANT_A = '11111111-1111-1111-1111-111111111111';
const TENANT_B = '22222222-2222-2222-2222-222222222222';

const admin = new PrismaClient({
  adapter: new PrismaPg({ connectionString: `postgresql://postgres:postgres@${DB}` }),
});
const newAppClient = () =>
  new PrismaClient({ adapter: new PrismaPg({ connectionString: `postgresql://app_user:app_user@${DB}` }) });

// How a user types the injected client.
const extend = (c: PrismaClient) => c.$extends(rowguardExtension());
type AppPrisma = ReturnType<typeof extend>;

// Stand-in for a real AuthGuard: sets req.user from a header.
// Guards run BEFORE interceptors, so tenantFrom can read req.user.
@Injectable()
class FakeAuthGuard implements CanActivate {
  canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest();
    const tenantId = req.headers['x-test-tenant'];
    if (tenantId !== undefined) req.user = { tenantId };
    return true;
  }
}

let handlerCalls = 0;

@Controller()
class NotesController {
  constructor(@InjectRowguard() private readonly prisma: AppPrisma) {}

  @Get('public')
  public() {
    handlerCalls++;
    return { ok: true };
  }

  @Get('notes')
  async list() {
    handlerCalls++;
    await sleep(Math.random() * 10); // interleave concurrent requests
    return this.prisma.note.findMany({ orderBy: { title: 'asc' } });
  }

  @Get('notes-rx')
  listRx(): Observable<unknown> {
    // Lazy: the query starts when Nest subscribes, inside the interceptor's run().
    return defer(async () => {
      await sleep(5);
      return this.prisma.note.findMany({ orderBy: { title: 'asc' } });
    });
  }

  @Post('notes')
  create() {
    return this.prisma.note.create({ data: { title: 'created' } });
  }

  @Get('notes-tx')
  countInTx() {
    return this.prisma.$transaction(async (tx) => ({ count: await tx.note.count() }));
  }
}

// Stand-in for ConfigModule, to test forRootAsync with inject.
const CONFIG = 'CONFIG';
@Module({ providers: [{ provide: CONFIG, useValue: { newClient: newAppClient } }], exports: [CONFIG] })
class FakeConfigModule {}

const defaultTenantFrom = (req: any) => req.user?.tenantId;

async function createApp(tenantFrom: RowguardModuleOptions['tenantFrom'] = defaultTenantFrom) {
  const moduleRef = await Test.createTestingModule({
    imports: [
      RowguardModule.forRootAsync({
        imports: [FakeConfigModule],
        inject: [CONFIG],
        useFactory: (config: { newClient: typeof newAppClient }) => ({
          tenantFrom,
          client: config.newClient,
        }),
      }),
    ],
    controllers: [NotesController],
    providers: [{ provide: APP_GUARD, useClass: FakeAuthGuard }],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  await app.init();
  return app;
}

let app: INestApplication;
const http = () => request(app.getHttpServer());

beforeAll(async () => {
  await admin.tenant.createMany({
    data: [
      { id: TENANT_A, name: 'A' },
      { id: TENANT_B, name: 'B' },
    ],
    skipDuplicates: true,
  });
  app = await createApp();
  // Listen once; otherwise supertest starts the server again for every request.
  await app.listen(0);
});

beforeEach(async () => {
  handlerCalls = 0;
  // As the superuser (table owner), not app_user: RLS would hide rows from app_user.
  await admin.$executeRaw`TRUNCATE "Comment", "Note" RESTART IDENTITY CASCADE`;
  await admin.note.createMany({
    data: [
      { tenantId: TENANT_A, title: 'a1' },
      { tenantId: TENANT_A, title: 'a2' },
      { tenantId: TENANT_B, title: 'b1' },
    ],
  });
});

afterAll(async () => {
  await app.close();
  await admin.$disconnect();
});

const titles = (body: { title: string }[]) => body.map((n) => n.title);

it('returns only the current tenant rows', async () => {
  const res = await http().get('/notes').set('x-test-tenant', TENANT_A).expect(200);
  expect(titles(res.body)).toEqual(['a1', 'a2']);
});

it('keeps concurrent requests apart', async () => {
  const tenants = Array.from({ length: 20 }, (_, i) => (i % 2 ? TENANT_B : TENANT_A));
  const responses = await Promise.all(tenants.map((t) => http().get('/notes').set('x-test-tenant', t)));
  responses.forEach((res, i) => {
    expect(titles(res.body)).toEqual(tenants[i] === TENANT_A ? ['a1', 'a2'] : ['b1']);
  });
});

it('keeps the tenant in an Observable handler', async () => {
  const res = await http().get('/notes-rx').set('x-test-tenant', TENANT_B).expect(200);
  expect(titles(res.body)).toEqual(['b1']);
});

it('POST without tenantId: filled by the database default', async () => {
  const res = await http().post('/notes').set('x-test-tenant', TENANT_B).expect(201);
  expect(res.body.tenantId).toBe(TENANT_B);
});

it('$transaction inside a handler', async () => {
  const res = await http().get('/notes-tx').set('x-test-tenant', TENANT_A).expect(200);
  expect(res.body).toEqual({ count: 2 });
});

it('public route works without a tenant', async () => {
  await http().get('/public').expect(200, { ok: true });
});

it('database route without a tenant fails closed (500, no data)', async () => {
  const res = await http().get('/notes').expect(500);
  expect(JSON.stringify(res.body)).not.toContain('a1');
});

describe('tenantFrom edge cases', () => {
  let edgeApp: INestApplication;
  afterEach(() => edgeApp?.close());

  it("'' is treated as no tenant (fail closed)", async () => {
    edgeApp = await createApp(() => '');
    await request(edgeApp.getHttpServer()).get('/notes').expect(500);
    await request(edgeApp.getHttpServer()).get('/public').expect(200);
  });

  it('a throwing tenantFrom stops the request before the handler', async () => {
    edgeApp = await createApp(() => {
      throw new Error('bad token');
    });
    handlerCalls = 0;
    await request(edgeApp.getHttpServer()).get('/public').expect(500);
    expect(handlerCalls).toBe(0);
  });
});

it('disconnects the client when the app closes', async () => {
  const closingApp = await createApp();
  const client = closingApp.get(ROWGUARD_CLIENT);
  const spy = jest.spyOn(client, '$disconnect');
  await closingApp.close();
  expect(spy).toHaveBeenCalled();
});
