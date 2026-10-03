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
import { rowguardExtension } from './prisma-extension';
import { checkRowguardSetup, SetupCheckOptions } from './startup-check';

// The parts of a PrismaClient we rely on.
interface PrismaClientLike {
  $extends: (...args: any[]) => any;
  $disconnect: () => Promise<void>;
}

export interface RowguardModuleOptions extends SetupCheckOptions {
  /**
   * Reads the tenant id from the request. Runs after guards, so `req.user`
   * is available. null/undefined/'' = no tenant: queries will throw.
   * Must return a verified value (e.g. from the authenticated user), never
   * a raw client-controlled header.
   */
  tenantFrom: (req: any) => string | null | undefined;
  /** Creates the PrismaClient. rowguard adds its extension last. */
  client: () => PrismaClientLike;
  /**
   * Database setup check at startup. Default 'error': the app does not start
   * if tenant isolation is off (superuser, BYPASSRLS, table owner, RLS disabled).
   * 'warn' only logs; 'off' skips it.
   */
  startupCheck?: 'error' | 'warn' | 'off';
}

// Generates RowguardModule.forRoot() and forRootAsync() with the same options.
// `isGlobal` (default true): no need to import the module in every feature module.
const { ConfigurableModuleClass, MODULE_OPTIONS_TOKEN } = new ConfigurableModuleBuilder<RowguardModuleOptions>()
  .setClassMethodName('forRoot')
  .setExtras({ isGlobal: true }, (definition, extras) => ({ ...definition, global: extras.isGlobal }))
  .build();

/** DI token of the tenant-aware Prisma client. */
export const ROWGUARD_CLIENT = Symbol('ROWGUARD_CLIENT');

/** Injects the tenant-aware Prisma client: `constructor(@InjectRowguard() prisma: AppPrisma)`. */
export const InjectRowguard = () => Inject(ROWGUARD_CLIENT);

@Injectable()
export class RowguardInterceptor implements NestInterceptor {
  constructor(@Inject(MODULE_OPTIONS_TOKEN) private readonly options: RowguardModuleOptions) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    // v0.1 supports HTTP only. Elsewhere there is no context: queries fail closed.
    if (context.getType() !== 'http') return next.handle();

    // If tenantFrom throws, the error goes to Nest's exception handling and
    // the handler never runs.
    const tenantId = this.options.tenantFrom(context.switchToHttp().getRequest());

    if (tenantId === null || tenantId === undefined || (typeof tenantId === 'string' && tenantId.trim() === '')) {
      return next.handle(); // public route, or not logged in: no tenant context
    }
    if (typeof tenantId !== 'string') {
      throw new TypeError('rowguard: tenantFrom must return a string, null or undefined');
    }

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
      provide: ROWGUARD_CLIENT,
      inject: [MODULE_OPTIONS_TOKEN],
      // Our extension is added here, after anything the user added: always last.
      useFactory: (options: RowguardModuleOptions) => options.client().$extends(rowguardExtension()),
    },
    { provide: APP_INTERCEPTOR, useClass: RowguardInterceptor },
  ],
  exports: [ROWGUARD_CLIENT],
})
export class RowguardModule extends ConfigurableModuleClass implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('Rowguard');

  constructor(
    @Inject(ROWGUARD_CLIENT) private readonly client: PrismaClientLike,
    @Inject(MODULE_OPTIONS_TOKEN) private readonly options: RowguardModuleOptions,
  ) {
    super();
  }

  // Runs once when the app starts (app.init() / app.listen()).
  async onModuleInit() {
    const mode = this.options.startupCheck ?? 'error';
    if (mode === 'off') return;

    // Raw queries are not hooked by the extension, so no tenant context is needed.
    const result = await checkRowguardSetup(this.client as any, this.options);
    if (result.excludedTables.length > 0) {
      this.logger.log(`Tables excluded from RLS checks: ${result.excludedTables.join(', ')}`);
    }
    const errors = result.issues.filter((i) => i.level === 'error');
    for (const issue of result.issues) {
      if (issue.level === 'warn' || mode === 'warn') this.logger.warn(issue.message);
    }
    if (mode === 'error' && errors.length > 0) {
      const list = errors.map((e) => `- ${e.message}`).join('\n');
      throw new Error(`rowguard: tenant isolation is not enforced:\n${list}`);
    }
  }

  // Close the connection pool when the app shuts down (app.close()).
  async onModuleDestroy() {
    await this.client.$disconnect();
  }
}
