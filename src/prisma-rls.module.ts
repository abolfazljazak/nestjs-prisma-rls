import {
  CallHandler,
  ConfigurableModuleBuilder,
  ExecutionContext,
  Inject,
  Injectable,
  Logger,
  Module,
  NestInterceptor,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { Observable, Subscription } from 'rxjs';
import { tenantStorage } from './context';
import { prismaRlsExtension } from './prisma-extension';
import { checkPrismaRlsSetup, SetupCheckOptions } from './startup-check';

// The parts of a PrismaClient we rely on.
interface PrismaClientLike {
  $extends: (...args: any[]) => any;
  $disconnect: () => Promise<void>;
}

export interface PrismaRlsModuleOptions extends SetupCheckOptions {
  /**
   * Reads the tenant id from the request. Runs after guards, so `req.user`
   * is available. null/undefined/'' = no tenant: queries will throw.
   * Must return a verified value (e.g. from the authenticated user), never
   * a raw client-controlled header. Numbers (integer tenant ids) are
   * converted with String().
   */
  tenantFrom: (req: any) => string | number | null | undefined;
  /** Creates the PrismaClient. nestjs-prisma-rls adds its extension last. */
  client: () => PrismaClientLike;
  /**
   * Database setup check at startup. Default 'error': the app does not start
   * if tenant isolation is off (superuser, BYPASSRLS, table owner, RLS disabled).
   * 'warn' only logs; 'off' skips it.
   */
  startupCheck?: 'error' | 'warn' | 'off';
}

// Generates PrismaRlsModule.forRoot() and forRootAsync() with the same options.
// `isGlobal` (default true): no need to import the module in every feature module.
const { ConfigurableModuleClass, MODULE_OPTIONS_TOKEN } = new ConfigurableModuleBuilder<PrismaRlsModuleOptions>()
  .setClassMethodName('forRoot')
  .setExtras({ isGlobal: true }, (definition, extras) => ({ ...definition, global: extras.isGlobal }))
  .build();

/** DI token of the tenant-aware Prisma client. */
export const PRISMA_RLS_CLIENT = Symbol('PRISMA_RLS_CLIENT');

/** Injects the tenant-aware Prisma client: `constructor(@InjectPrismaRls() prisma: AppPrisma)`. */
export const InjectPrismaRls = () => Inject(PRISMA_RLS_CLIENT);

@Injectable()
export class PrismaRlsInterceptor implements NestInterceptor {
  constructor(@Inject(MODULE_OPTIONS_TOKEN) private readonly options: PrismaRlsModuleOptions) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    // v0.1 supports HTTP only. Elsewhere there is no context: queries fail closed.
    if (context.getType() !== 'http') return next.handle();

    // If tenantFrom throws, the error goes to Nest's exception handling and
    // the handler never runs.
    const value: unknown = this.options.tenantFrom(context.switchToHttp().getRequest());

    if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) {
      return next.handle(); // public route, or not logged in: no tenant context
    }
    // Integer tenant ids: set_config needs text, so convert. NaN/Infinity would
    // become "NaN"/"Infinity", which is never a real tenant: reject them.
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new TypeError(`nestjs-prisma-rls: tenantFrom returned ${value}, not a valid tenant id`);
    }
    if (typeof value !== 'string' && typeof value !== 'number') {
      throw new TypeError('nestjs-prisma-rls: tenantFrom must return a string, a number, null or undefined');
    }
    const tenantId = String(value);

    // Subscribe inside run(): the handler executes when subscribed, so it
    // (and everything it awaits) sees the tenant. Returning `sub.unsubscribe`
    // as teardown cancels the handler if the client goes away.
    return new Observable((subscriber) => {
      let sub: Subscription | undefined;
      tenantStorage.run({ tenantId }, () => {
        sub = next.handle().subscribe(subscriber);
      });
      return () => sub?.unsubscribe();
    });
  }
}

@Module({
  providers: [
    {
      provide: PRISMA_RLS_CLIENT,
      inject: [MODULE_OPTIONS_TOKEN],
      // Our extension is added here, after anything the user added: always last.
      useFactory: (options: PrismaRlsModuleOptions) => options.client().$extends(prismaRlsExtension()),
    },
    { provide: APP_INTERCEPTOR, useClass: PrismaRlsInterceptor },
  ],
  exports: [PRISMA_RLS_CLIENT],
})
export class PrismaRlsModule extends ConfigurableModuleClass implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('PrismaRls');

  constructor(
    @Inject(PRISMA_RLS_CLIENT) private readonly client: PrismaClientLike,
    @Inject(MODULE_OPTIONS_TOKEN) private readonly options: PrismaRlsModuleOptions,
  ) {
    super();
  }

  // Runs once when the app starts (app.init() / app.listen()).
  async onModuleInit() {
    const mode = this.options.startupCheck ?? 'error';
    if (mode === 'off') return;

    // Raw queries are not hooked by the extension, so no tenant context is needed.
    const result = await checkPrismaRlsSetup(this.client as any, this.options);
    if (result.excludedTables.length > 0) {
      this.logger.log(`Tables excluded from RLS checks: ${result.excludedTables.join(', ')}`);
    }
    const errors = result.issues.filter((i) => i.level === 'error');
    for (const issue of result.issues) {
      if (issue.level === 'warn' || mode === 'warn') this.logger.warn(issue.message);
    }
    if (mode === 'error' && errors.length > 0) {
      const list = errors.map((e) => `- ${e.message}`).join('\n');
      throw new Error(`nestjs-prisma-rls: tenant isolation is not enforced:\n${list}`);
    }
  }

  // Close the connection pool when the app shuts down (app.close()).
  async onModuleDestroy() {
    await this.client.$disconnect();
  }
}
