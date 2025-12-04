declare module 'config' {
  /**
   * Format string consumed by the Morgan logger in `app.ts`.
   * Use `false` to disable request logging entirely.
   */
  type LoggerFormat = false | string;

  /**
   * HTTPS listener settings read by the CLI entry point when the
   * application bootstraps an HTTPS server and reloads certificates on SIGHUP
   * (see `bin/www.ts`).
   */
  interface HTTPSConfig {
    enabled: boolean;
    port: number;
    certPath: string;
    keyPath: string;
    host?: string;
    caPath?: string;
  }

  /**
   * Connection pool configuration passed into the DAL factory whenever the
   * PostgreSQL layer is initialized or migrations run (see `db-postgres.ts`).
   */
  interface PostgresConfig {
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
    max: number;
    idleTimeoutMillis: number;
    connectionTimeoutMillis: number;
    allowExitOnIdle?: boolean;
    schema?: string;
  }

  /**
   * Declarative captcha configuration consulted by the forms helper while
   * rendering captcha prompts and validating user responses
   * (see `routes/helpers/forms.ts`).
   */
  interface QuestionCaptchaConfig {
    forms: Record<string, boolean | string>;
    captchas: Array<{
      questionKey: string;
      answerKey: string;
      placeholderKey?: string;
    }>;
  }

  /**
   * ElasticSearch endpoint configuration used when the backend talks to the
   * search process (see `search.ts`).
   */
  interface SearchConfig {
    port: number;
    host: string;
    log: string;
  }

  /**
   * Mapping of webhook identifiers to callback URLs. The dispatcher reads this
   * structure before notifying third-party services (see `util/webhooks.ts`).
   */
  type WebHookTargets = Record<string, string[]>;

  /**
   * Options forwarded to the `irc-upd` client when the webhook bridge connects
   * to Libera Chat and handles nickname recovery (see `tools/irc-bot.ts`).
   */
  interface IRCConnectionOptions {
    userName: string;
    port: number;
    channels: string[];
    secure: boolean;
    sasl: boolean;
    password: string;
    debug: boolean;
  }

  /**
   * High-level IRC integration settings exposed to the webhook bridge HTTP
   * service (see `tools/irc-bot.ts`).
   */
  interface IRCConfig {
    appPort: number;
    botName: string;
    options: IRCConnectionOptions;
    server: string;
  }

  /**
   * Shared runtime configuration that powers the Express app, DAL,
   * and background tooling. Callers typically access fields through
   * `ConfigModule.get` to keep parity with production settings.
   */
  interface AppConfig {
    maintenanceMode: boolean;
    logger: LoggerFormat;
    qualifiedURL: string;
    devPort: number;
    email?: {
      enabled: boolean;
      provider: string;
      mailgun: {
        apiKey: string;
        domain: string;
        from: string;
        url: string;
      };
    };
    passwordReset?: {
      tokenExpirationHours: number;
      rateLimitPerIP: number;
      cooldownHours: number;
    };
    accountRequests?: {
      enabled: boolean;
      rateLimitPerIP: number;
      rateLimitWindowHours: number;
      emailCooldownHours: number;
      retentionDays: number;
    };
    https: HTTPSConfig;
    forceHTTPS?: boolean;
    postgres: PostgresConfig;
    sessionSecret: string;
    adminEmail: string;
    sessionCookieDuration: number;
    uploadTempDir: string;
    uploadMaxSize: number;
    frontPageTeamBlog: string;
    frontPageTeamBlogKey: string;
    requireInviteLinks: boolean;
    questionCaptcha: QuestionCaptchaConfig;
    adapterUserAgent: string;
    adapterTimeout: number;
    search: SearchConfig;
    webHooks: WebHookTargets;
    irc: IRCConfig;
    defaultLocale?: LibReviews.LocaleCode;
    [key: string]: unknown;
  }

  /**
   * Runtime configuration facade returned by `import config from 'config'`.
   * Exposes strongly typed getters while still allowing legacy direct property
   * access used throughout the code base.
   */
  interface ConfigModule extends AppConfig {
    get<T extends keyof AppConfig>(key: T): AppConfig[T];
    get<T = unknown>(key: string): T;
    has(key: keyof AppConfig | string): boolean;
    util?: {
      toObject(): AppConfig;
      cloneDeep?<T>(value: T): T;
    };
  }

  /**
   * Default export provided by the `config` package with lib.reviews specific
   * typings attached.
   */
  const config: ConfigModule;
  export type {
    AppConfig,
    HTTPSConfig,
    IRCConfig,
    IRCConnectionOptions,
    LoggerFormat,
    PostgresConfig,
    QuestionCaptchaConfig,
    SearchConfig,
    WebHookTargets,
    ConfigModule,
  };
  export default config;
}
