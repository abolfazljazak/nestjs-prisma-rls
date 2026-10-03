// Read-only checks of the Postgres setup. They catch the configurations where
// RLS is silently off and every tenant sees every row.
import { TENANT_SETTING } from './prisma-extension';

export type IssueLevel = 'error' | 'warn';

export interface SetupIssue {
  /** error = tenant isolation is off; warn = probably misconfigured. */
  level: IssueLevel;
  code: string;
  message: string;
  table?: string;
}

export interface SetupCheckOptions {
  /** Column that marks a tenant table. Default: 'tenantId'. */
  tenantColumn?: string;
  /** Tables with the tenant column that intentionally have no RLS (e.g. User). */
  excludeTables?: string[];
  /** Schema to inspect. Default: the connection's current_schema(). */
  schema?: string;
}

export interface SetupCheckResult {
  issues: SetupIssue[];
  tenantTables: string[];
  excludedTables: string[];
}

// Only raw queries are needed; any PrismaClient (extended or not) has them.
interface RawQueryClient {
  $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>;
}

interface RoleRow {
  name: string;
  superuser: boolean;
  bypassrls: boolean;
}

const currentRole = async (client: RawQueryClient) =>
  (
    await client.$queryRaw<RoleRow[]>`
      SELECT rolname AS name, rolsuper AS superuser, rolbypassrls AS bypassrls
      FROM pg_roles WHERE rolname = current_user`
  )[0];

/** Checks the role and tables used by the normal (tenant-scoped) client. */
export async function checkPrismaRlsSetup(
  client: RawQueryClient,
  options: SetupCheckOptions = {},
): Promise<SetupCheckResult> {
  const column = options.tenantColumn ?? 'tenantId';
  const schema = options.schema ?? null;
  const excluded = new Set(options.excludeTables ?? []);
  const issues: SetupIssue[] = [];

  const role = await currentRole(client);
  if (role.superuser) {
    issues.push({ level: 'error', code: 'ROLE_SUPERUSER', message: `Role "${role.name}" is a superuser: RLS does not apply to it.` });
  } else if (role.bypassrls) {
    issues.push({ level: 'error', code: 'ROLE_BYPASSRLS', message: `Role "${role.name}" has BYPASSRLS: RLS does not apply to it.` });
  }

  // Tables in the schema that have the tenant column.
  // owner_privs: pg_has_role(..., 'USAGE') is true for the owner AND for members
  // that inherit the owner's privileges; Postgres skips RLS for all of them.
  const tables = await client.$queryRaw<
    { table: string; rls: boolean; force: boolean; owner_privs: boolean; owner: string }[]
  >`
    SELECT c.relname AS "table", c.relrowsecurity AS rls, c.relforcerowsecurity AS force,
           pg_has_role(current_user, c.relowner, 'USAGE') AS owner_privs,
           pg_get_userbyid(c.relowner) AS owner
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p')
      AND n.nspname = coalesce(${schema}::text, current_schema())
      AND EXISTS (SELECT 1 FROM pg_attribute a
                  WHERE a.attrelid = c.oid AND a.attname = ${column}
                    AND a.attnum > 0 AND NOT a.attisdropped)
    ORDER BY c.relname`;

  // permissive: permissive policies are OR-ed, so one that doesn't check the
  //   tenant opens the whole table. RESTRICTIVE ones are AND-ed (harmless).
  // applies: the policy targets PUBLIC (oid 0) or a role whose privileges
  //   current_user has. pg_has_role() fails on oid 0; CASE guarantees it isn't
  //   called for it (SQL does not promise left-to-right OR evaluation).
  const policies = await client.$queryRaw<
    { table: string; name: string; using: string | null; check: string | null; permissive: boolean; applies: boolean }[]
  >`
    SELECT c.relname AS "table", p.polname AS name,
           pg_get_expr(p.polqual, p.polrelid) AS using,
           pg_get_expr(p.polwithcheck, p.polrelid) AS check,
           p.polpermissive AS permissive,
           EXISTS (SELECT 1 FROM unnest(p.polroles) AS r
                   WHERE CASE WHEN r = 0 THEN true ELSE pg_has_role(current_user, r, 'USAGE') END) AS applies
    FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = coalesce(${schema}::text, current_schema())`;

  const tenantTables: string[] = [];
  const excludedTables: string[] = [];

  for (const t of tables) {
    if (excluded.has(t.table)) {
      excludedTables.push(t.table);
      continue;
    }
    tenantTables.push(t.table);

    if (!t.rls) {
      issues.push({ level: 'error', code: 'RLS_DISABLED', table: t.table, message: `Table "${t.table}" has "${column}" but RLS is not enabled.` });
      continue;
    }
    if (t.owner_privs && !role.superuser) {
      if (!t.force) {
        issues.push({
          level: 'error',
          code: 'TABLE_OWNER',
          table: t.table,
          message: `Role "${role.name}" owns "${t.table}" (or inherits from its owner "${t.owner}"): RLS does not apply. Use a non-owner role.`,
        });
      } else {
        // FORCE makes RLS apply to the owner, but the owner can still run
        // ALTER TABLE ... DISABLE ROW LEVEL SECURITY or DROP POLICY.
        issues.push({
          level: 'warn',
          code: 'TABLE_OWNER_FORCED',
          table: t.table,
          message: `Role "${role.name}" owns "${t.table}" (or inherits from its owner "${t.owner}"). FORCE ROW LEVEL SECURITY applies RLS to it, but the owner can still disable RLS or drop the policy (e.g. via SQL injection). Use a non-owner role for the app.`,
        });
      }
    }

    const own = policies.filter((p) => p.table === t.table);
    if (own.length === 0) {
      issues.push({ level: 'warn', code: 'NO_POLICY', table: t.table, message: `Table "${t.table}" has RLS enabled but no policy: every query is denied.` });
    }
    for (const p of own) {
      const exprs = [p.using, p.check].filter((e): e is string => e !== null);
      // Text heuristic, not a proof: it only checks that the setting is mentioned.
      if (exprs.some((e) => e.includes(TENANT_SETTING))) continue;
      if (p.permissive && p.applies) {
        issues.push({
          level: 'error',
          code: 'POLICY_OPENS_TABLE',
          table: t.table,
          message: `Permissive policy "${p.name}" on "${t.table}" applies to role "${role.name}" but does not reference ${TENANT_SETTING}: permissive policies are OR-ed, so it opens the table.`,
        });
      } else if (!p.permissive) {
        issues.push({
          level: 'warn',
          code: 'POLICY_NO_TENANT',
          table: t.table,
          message: `Restrictive policy "${p.name}" on "${t.table}" does not reference ${TENANT_SETTING}.`,
        });
      }
      // Permissive but only for other roles: does not affect this client.
    }
  }

  if (tenantTables.length === 0) {
    issues.push({ level: 'warn', code: 'NO_TENANT_TABLES', message: `No tables with a "${column}" column found: check tenantColumn and schema.` });
  }

  return { issues, tenantTables, excludedTables };
}

/** Checks the role used by the admin (bypass) client. */
export async function checkPrismaRlsAdminSetup(client: RawQueryClient): Promise<SetupIssue[]> {
  const role = await currentRole(client);
  if (role.superuser) {
    return [{ level: 'warn', code: 'ADMIN_SUPERUSER', message: `Admin role "${role.name}" is a superuser: more privilege than BYPASSRLS needs.` }];
  }
  if (!role.bypassrls) {
    return [{ level: 'warn', code: 'ADMIN_NO_BYPASSRLS', message: `Admin role "${role.name}" lacks BYPASSRLS: admin queries will only see rows RLS allows.` }];
  }
  return [];
}
