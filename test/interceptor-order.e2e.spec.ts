// Documents a limitation: a global interceptor that runs BEFORE ours has no
// tenant context. Nest runs global interceptors in registration order.
import 'reflect-metadata';
import { CallHandler, Controller, ExecutionContext, Get, Injectable, Module, NestInterceptor } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { getTenantId, PrismaRlsModule } from '../src';

let seenByOther: string;

@Injectable()
class OtherInterceptor implements NestInterceptor {
  intercept(_ctx: ExecutionContext, next: CallHandler) {
    try {
      seenByOther = getTenantId();
    } catch (err) {
      seenByOther = (err as Error).name;
    }
    return next.handle();
  }
}

@Module({ providers: [{ provide: APP_INTERCEPTOR, useClass: OtherInterceptor }] })
class OtherInterceptorModule {}

@Controller()
class PingController {
  @Get('ping')
  ping() {
    return { tenantId: getTenantId() };
  }
}

const prismaRls = PrismaRlsModule.forRoot({
  tenantFrom: () => 'tenant-1',
  client: () => ({ $extends: () => ({ $disconnect: async () => undefined }), $disconnect: async () => undefined }),
  startupCheck: 'off',
});

async function seenWith(imports: any[]) {
  const moduleRef = await Test.createTestingModule({ imports, controllers: [PingController] }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  await app.init();
  try {
    const res = await request(app.getHttpServer()).get('/ping').expect(200);
    expect(res.body).toEqual({ tenantId: 'tenant-1' }); // the handler always has the tenant
    return seenByOther;
  } finally {
    await app.close();
  }
}

it('an interceptor registered BEFORE PrismaRlsModule has no tenant context', async () => {
  expect(await seenWith([OtherInterceptorModule, prismaRls])).toBe('MissingTenantError');
});

it('an interceptor registered AFTER PrismaRlsModule sees the tenant', async () => {
  expect(await seenWith([prismaRls, OtherInterceptorModule])).toBe('tenant-1');
});
