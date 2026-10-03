import { ConfigurableModuleBuilder, Inject, Logger, Module, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { checkRowguardAdminSetup } from './startup-check';

// The parts of a PrismaClient we rely on.
interface DisconnectableClient {
  $disconnect: () => Promise<void>;
}

export interface RowguardAdminModuleOptions {
  /**
   * Creates a PrismaClient connected as a separate role with BYPASSRLS
   * (e.g. from ROWGUARD_ADMIN_DATABASE_URL). It sees every tenant's rows.
   * No rowguard extension is added: it needs no tenant context.
   */
  client: () => DisconnectableClient;
  /** Logs a warning if the admin role lacks BYPASSRLS. Default 'warn'. */
  startupCheck?: 'warn' | 'off';
}

const { ConfigurableModuleClass, MODULE_OPTIONS_TOKEN } = new ConfigurableModuleBuilder<RowguardAdminModuleOptions>()
  .setClassMethodName('forRoot')
  .setExtras({ isGlobal: true }, (definition, extras) => ({ ...definition, global: extras.isGlobal }))
  .build();

/** DI token of the admin (RLS-bypassing) Prisma client. */
export const ROWGUARD_ADMIN_CLIENT = Symbol('ROWGUARD_ADMIN_CLIENT');

/**
 * Injects the admin client, which bypasses tenant isolation.
 * Never return its results directly to tenant users.
 */
export const InjectRowguardAdmin = () => Inject(ROWGUARD_ADMIN_CLIENT);

// A separate, opt-in module: if it isn't imported, injecting the admin
// client fails when the app boots, instead of failing later at runtime.
@Module({
  providers: [
    {
      provide: ROWGUARD_ADMIN_CLIENT,
      inject: [MODULE_OPTIONS_TOKEN],
      useFactory: (options: RowguardAdminModuleOptions) => options.client(),
    },
  ],
  exports: [ROWGUARD_ADMIN_CLIENT],
})
export class RowguardAdminModule extends ConfigurableModuleClass implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('RowguardAdmin');

  constructor(
    @Inject(ROWGUARD_ADMIN_CLIENT) private readonly client: DisconnectableClient,
    @Inject(MODULE_OPTIONS_TOKEN) private readonly options: RowguardAdminModuleOptions,
  ) {
    super();
  }

  async onModuleInit() {
    if (this.options.startupCheck === 'off') return;
    for (const issue of await checkRowguardAdminSetup(this.client as any)) this.logger.warn(issue.message);
  }

  async onModuleDestroy() {
    await this.client.$disconnect();
  }
}
