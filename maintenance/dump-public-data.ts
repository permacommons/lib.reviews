#!/usr/bin/env node
/**
 * Create sanitized database dumps for public distribution using SQL views
 *
 * This variant materializes sanitized/current views that encapsulate all
 * filtering logic, dumps from those views, then drops them once complete.
 */

import { spawn } from 'node:child_process';
import type { SpawnOptions } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Writable } from 'node:stream';

import config from 'config';
import type { PostgresConfig } from 'config';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

const EXPORT_DIR = path.join(moduleDir, '../static/downloads/dumps');
const ISO_DATE = new Date().toISOString().split('T')[0];
const SQL_FILE = `dump-${ISO_DATE}.sql`;
const TAR_FILE = `dump-${ISO_DATE}.tgz`;

const TEMP_SCHEMA = 'dump_public_export';

// Convenience helper for current revision predicate using a table alias
const nonDeleted = (alias: string): string => `COALESCE(${alias}._rev_deleted, FALSE) = FALSE`;

type SelectOverrides = Record<string, string>;

interface ViewJoin {
  type?: string;
  target: string;
  alias?: string;
  on: string;
}

interface ViewConfig {
  name: string;
  baseTable: string;
  alias: string;
  selectOverrides?: SelectOverrides;
  joins?: ViewJoin[];
  where?: string;
}

interface RunCommandOptions extends SpawnOptions {
  outputStream?: Writable;
}

const sanitizedUserOverrides: SelectOverrides = {
  email: 'NULL::VARCHAR(128)',
  password: 'NULL::TEXT',
  invite_link_count: '0',
  show_error_details: 'FALSE',
  is_trusted: 'TRUE',
  is_site_moderator: 'FALSE',
  is_super_user: 'FALSE',
  suppressed_notices: 'ARRAY[]::TEXT[]',
  prefers_rich_text_editor: 'FALSE',
};

const VIEW_CONFIGS: ViewConfig[] = [
  {
    name: 'sanitized_users',
    baseTable: 'users',
    alias: 'u',
    selectOverrides: sanitizedUserOverrides,
  },
  {
    name: 'non_deleted_teams',
    baseTable: 'teams',
    alias: 't',
    where: nonDeleted('t'),
  },
  {
    name: 'non_deleted_things',
    baseTable: 'things',
    alias: 'th',
    where: nonDeleted('th'),
  },
  {
    name: 'non_deleted_files',
    baseTable: 'files',
    alias: 'f',
    where: nonDeleted('f'),
  },
  {
    name: 'non_deleted_blog_posts',
    baseTable: 'blog_posts',
    alias: 'bp',
    joins: [
      {
        type: 'LEFT JOIN',
        target: `${TEMP_SCHEMA}.non_deleted_teams`,
        alias: 'tm',
        on: 'tm.id = bp.team_id',
      },
    ],
    where: `${nonDeleted('bp')} AND (bp.team_id IS NULL OR tm.id IS NOT NULL)`,
  },
  {
    name: 'non_deleted_reviews',
    baseTable: 'reviews',
    alias: 'r',
    joins: [
      {
        type: 'JOIN',
        target: `${TEMP_SCHEMA}.non_deleted_things`,
        alias: 'th',
        on: 'th.id = r.thing_id',
      },
      {
        type: 'LEFT JOIN',
        target: `${TEMP_SCHEMA}.non_deleted_files`,
        alias: 'fi',
        on: 'fi.id = r.social_image_id',
      },
    ],
    where: `${nonDeleted('r')} AND (r.social_image_id IS NULL OR fi.id IS NOT NULL)`,
  },
  {
    name: 'non_deleted_user_metas',
    baseTable: 'user_metas',
    alias: 'um',
    where: nonDeleted('um'),
  },
  {
    name: 'non_deleted_review_teams',
    baseTable: 'review_teams',
    alias: 'rt',
    joins: [
      {
        type: 'JOIN',
        target: `${TEMP_SCHEMA}.non_deleted_reviews`,
        alias: 'r',
        on: 'r.id = rt.review_id',
      },
      {
        type: 'JOIN',
        target: `${TEMP_SCHEMA}.non_deleted_teams`,
        alias: 't',
        on: 't.id = rt.team_id',
      },
    ],
  },
  {
    name: 'non_deleted_team_members',
    baseTable: 'team_members',
    alias: 'tm',
    joins: [
      {
        type: 'JOIN',
        target: `${TEMP_SCHEMA}.non_deleted_teams`,
        alias: 't',
        on: 't.id = tm.team_id',
      },
    ],
  },
  {
    name: 'non_deleted_team_moderators',
    baseTable: 'team_moderators',
    alias: 'tm',
    joins: [
      {
        type: 'JOIN',
        target: `${TEMP_SCHEMA}.non_deleted_teams`,
        alias: 't',
        on: 't.id = tm.team_id',
      },
    ],
  },
  {
    name: 'non_deleted_team_slugs',
    baseTable: 'team_slugs',
    alias: 'ts',
    joins: [
      {
        type: 'JOIN',
        target: `${TEMP_SCHEMA}.non_deleted_teams`,
        alias: 't',
        on: 't.id = ts.team_id',
      },
    ],
  },
  {
    name: 'non_deleted_thing_files',
    baseTable: 'thing_files',
    alias: 'tf',
    joins: [
      {
        type: 'JOIN',
        target: `${TEMP_SCHEMA}.non_deleted_things`,
        alias: 'th',
        on: 'th.id = tf.thing_id',
      },
      {
        type: 'JOIN',
        target: `${TEMP_SCHEMA}.non_deleted_files`,
        alias: 'fi',
        on: 'fi.id = tf.file_id',
      },
    ],
  },
  {
    name: 'non_deleted_thing_slugs',
    baseTable: 'thing_slugs',
    alias: 'ts',
    joins: [
      {
        type: 'JOIN',
        target: `${TEMP_SCHEMA}.non_deleted_things`,
        alias: 'th',
        on: 'th.id = ts.thing_id',
      },
    ],
  },
];

// Get PostgreSQL connection config
const pgConfig = config.get<PostgresConfig>('postgres');
const dbHost = pgConfig.host ?? 'localhost';
const dbPort = pgConfig.port ?? 5432;
const dbName = pgConfig.database ?? 'libreviews';
const dbUser = pgConfig.user ?? 'libreviews_user';

console.log('Creating sanitized database dump using view strategy...');
console.log(`Database: ${dbName} on ${dbHost}:${dbPort}`);

// Ensure export directory exists
if (!fs.existsSync(EXPORT_DIR)) {
  fs.mkdirSync(EXPORT_DIR, { recursive: true });
}

const outputPath = path.join(EXPORT_DIR, SQL_FILE);
const tarPath = path.join(EXPORT_DIR, TAR_FILE);

/**
 * Run a shell command and wait for completion.
 */
function runCommand(
  command: string,
  args: string[],
  options: RunCommandOptions = {}
): Promise<void> {
  return new Promise((resolve, reject) => {
    const { outputStream, stdio, ...spawnOverrides } = options;
    const spawnOptions: SpawnOptions = {
      ...spawnOverrides,
      stdio: outputStream ? ['ignore', 'pipe', 'inherit'] : (stdio ?? 'inherit'),
    };

    const proc = spawn(command, args, spawnOptions);

    if (outputStream && proc.stdout) {
      proc.stdout.pipe(outputStream, { end: false });
    }

    proc.on('close', code => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} exited with code ${code}`));
      }
    });

    proc.on('error', reject);
  });
}

async function getTableColumnNames(tableName: string, env: NodeJS.ProcessEnv): Promise<string[]> {
  const columnsQuery = `
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = '${tableName}'
    ORDER BY ordinal_position
  `.trim();

  return new Promise((resolve, reject) => {
    const psql = spawn('psql', ['-t', '-A', '-c', columnsQuery], {
      env,
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let output = '';

    if (psql.stdout) {
      psql.stdout.on('data', data => {
        output += data.toString();
      });
    }

    psql.on('close', code => {
      if (code === 0) {
        const columns = output
          .split('\n')
          .map(entry => entry.trim())
          .filter(Boolean);
        resolve(columns);
      } else {
        reject(new Error(`psql exited with code ${code}`));
      }
    });
    psql.on('error', reject);
  });
}

async function getTableColumnsString(tableName: string, env: NodeJS.ProcessEnv): Promise<string> {
  const columns = await getTableColumnNames(tableName, env);
  return columns.join(', ');
}

async function createViewFromConfig(
  configEntry: ViewConfig,
  env: NodeJS.ProcessEnv
): Promise<void> {
  const columns = await getTableColumnNames(configEntry.baseTable, env);
  const selectExpressions = columns.map(column => {
    if (
      configEntry.selectOverrides &&
      Object.prototype.hasOwnProperty.call(configEntry.selectOverrides, column)
    ) {
      return `${configEntry.selectOverrides[column]} AS ${column}`;
    }
    return `${configEntry.alias}.${column}`;
  });

  const selectSection = selectExpressions.map(expr => `  ${expr}`).join(',\n');
  const lines = [
    `CREATE VIEW ${TEMP_SCHEMA}.${configEntry.name} AS`,
    'SELECT',
    selectSection,
    `FROM public.${configEntry.baseTable} ${configEntry.alias}`,
  ];

  if (configEntry.joins) {
    for (const join of configEntry.joins) {
      const joinType = join.type || 'JOIN';
      const aliasClause = join.alias ? ` ${join.alias}` : '';
      lines.push(`  ${joinType} ${join.target}${aliasClause} ON ${join.on}`);
    }
  }

  if (configEntry.where) {
    lines.push(`WHERE ${configEntry.where}`);
  }

  const statement = `${lines.join('\n')};`;
  await runCommand('psql', ['-c', statement], { env });
}

async function copyFromView(
  targetTable: string,
  viewName: string,
  outputStream: fs.WriteStream,
  env: NodeJS.ProcessEnv,
  { orderBy = null }: { orderBy?: string | null } = {}
): Promise<void> {
  const columns = await getTableColumnsString(targetTable, env);
  outputStream.write(
    `\n--\n-- Data for Name: ${targetTable}; Type: TABLE DATA; Schema: public; Owner: -\n--\n\n`
  );
  outputStream.write(`COPY public.${targetTable} (${columns}) FROM stdin;\n`);

  const orderClause = orderBy ? ` ORDER BY ${orderBy}` : '';
  const query = `COPY (SELECT * FROM ${viewName}${orderClause}) TO STDOUT`;

  await runCommand('psql', ['-c', query], { outputStream, env });
  outputStream.write('\\.\n\n');
}

async function ensureTempSchema(env: NodeJS.ProcessEnv): Promise<void> {
  await runCommand('psql', ['-c', `DROP SCHEMA IF EXISTS ${TEMP_SCHEMA} CASCADE`], { env });
  await runCommand('psql', ['-c', `CREATE SCHEMA ${TEMP_SCHEMA}`], { env });
  for (const configEntry of VIEW_CONFIGS) {
    await createViewFromConfig(configEntry, env);
  }
}

async function cleanupTempSchema(env: NodeJS.ProcessEnv): Promise<void> {
  await runCommand('psql', ['-c', `DROP SCHEMA IF EXISTS ${TEMP_SCHEMA} CASCADE`], { env });
}

/**
 * Main dump process
 */
async function createDump(): Promise<void> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PGHOST: dbHost,
    PGPORT: dbPort.toString(),
    PGDATABASE: dbName,
    PGUSER: dbUser,
  };

  if (pgConfig.password) {
    env.PGPASSWORD = pgConfig.password;
  }

  if (fs.existsSync(tarPath)) {
    console.log(`Overwriting existing dump for ${ISO_DATE}`);
  }

  let outputStream: fs.WriteStream | null = null;
  try {
    await ensureTempSchema(env);

    outputStream = fs.createWriteStream(outputPath);

    console.log('Step 1: Dumping schema...');
    await runCommand(
      'pg_dump',
      ['--schema-only', '--no-owner', '--no-privileges', '--no-tablespaces'],
      {
        outputStream,
        env,
      }
    );

    console.log('Step 2: Dumping migrations table...');
    await runCommand(
      'pg_dump',
      ['--data-only', '--no-owner', '--no-privileges', '--table=migrations'],
      {
        outputStream,
        env,
      }
    );

    console.log('Step 3: Dumping sanitized users via view...');
    await copyFromView('users', `${TEMP_SCHEMA}.sanitized_users`, outputStream, env, {
      orderBy: 'registration_date',
    });

    console.log('Step 4: Dumping revision tables via views...');
    await copyFromView('teams', `${TEMP_SCHEMA}.non_deleted_teams`, outputStream, env);
    await copyFromView('things', `${TEMP_SCHEMA}.non_deleted_things`, outputStream, env);
    await copyFromView('files', `${TEMP_SCHEMA}.non_deleted_files`, outputStream, env);
    await copyFromView('blog_posts', `${TEMP_SCHEMA}.non_deleted_blog_posts`, outputStream, env);
    await copyFromView('reviews', `${TEMP_SCHEMA}.non_deleted_reviews`, outputStream, env);
    await copyFromView('user_metas', `${TEMP_SCHEMA}.non_deleted_user_metas`, outputStream, env);

    console.log('Step 5: Dumping junction tables via views...');
    await copyFromView(
      'review_teams',
      `${TEMP_SCHEMA}.non_deleted_review_teams`,
      outputStream,
      env
    );
    await copyFromView(
      'team_members',
      `${TEMP_SCHEMA}.non_deleted_team_members`,
      outputStream,
      env
    );
    await copyFromView(
      'team_moderators',
      `${TEMP_SCHEMA}.non_deleted_team_moderators`,
      outputStream,
      env
    );
    await copyFromView('team_slugs', `${TEMP_SCHEMA}.non_deleted_team_slugs`, outputStream, env);
    await copyFromView('thing_files', `${TEMP_SCHEMA}.non_deleted_thing_files`, outputStream, env);
    await copyFromView('thing_slugs', `${TEMP_SCHEMA}.non_deleted_thing_slugs`, outputStream, env);

    outputStream.end();
    await once(outputStream, 'finish');

    console.log('Step 6: Compressing dump...');
    await runCommand('tar', ['-czf', tarPath, '-C', EXPORT_DIR, SQL_FILE], { stdio: 'inherit' });

    fs.unlinkSync(outputPath);

    const latestPath = path.join(EXPORT_DIR, 'latest.tgz');
    if (fs.existsSync(latestPath)) {
      fs.unlinkSync(latestPath);
    }
    fs.symlinkSync(TAR_FILE, latestPath);

    console.log(`\nDump complete: ${tarPath}`);
    console.log(`Symlink updated: ${latestPath}`);

    const stats = fs.statSync(tarPath);
    const sizeMB = (stats.size / 1024 / 1024).toFixed(2);
    console.log(`File size: ${sizeMB} MB`);
  } catch (error) {
    const serialized = error instanceof Error ? error : new Error(String(error));
    console.error('Error creating dump:', serialized);
    process.exitCode = 1;
  } finally {
    if (outputStream && !outputStream.closed) {
      outputStream.end();
      try {
        await once(outputStream, 'finish');
      } catch {
        // ignore flush errors during teardown
      }
    }
    try {
      await cleanupTempSchema(env);
    } catch (cleanupError) {
      const serializedCleanupError =
        cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError));
      console.error('Failed to clean up temporary schema:', serializedCleanupError);
    }
    if (fs.existsSync(outputPath)) {
      try {
        fs.unlinkSync(outputPath);
      } catch {
        // ignore cleanup errors for partially written files
      }
    }
  }
}

createDump().catch(error => {
  const serialized = error instanceof Error ? error : new Error(String(error));
  console.error('Fatal error:', serialized);
  process.exit(1);
});
