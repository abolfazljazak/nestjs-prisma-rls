import { ConfigurableModuleBuilder, Inject, Module, OnModuleDestroy } from '@nestjs/common';

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
export class RowguardAdminModule extends ConfigurableModuleClass implements OnModuleDestroy {
  constructor(@Inject(ROWGUARD_ADMIN_CLIENT) private readonly client: DisconnectableClient) {
    super();
  }

  async onModuleDestroy() {
    await this.client.$disconnect();
  }
}
