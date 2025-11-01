declare module 'config' {
  type LoggerFormat = false | string;

  interface HTTPSConfig {
    enabled: boolean;
    port: number;
    certPath: string;
    keyPath: string;
  }

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

  interface QuestionCaptchaConfig {
    forms: Record<string, boolean>;
    captchas: Array<{
      questionKey: string;
      answerKey: string;
    }>;
  }

  interface SearchConfig {
    port: number;
    host: string;
    log: string;
  }

  type WebHookTargets = Record<string, string[]>;

  interface IRCConnectionOptions {
    userName: string;
    port: number;
    channels: string[];
    secure: boolean;
    sasl: boolean;
    password: string;
    debug: boolean;
  }

  interface IRCConfig {
    appPort: number;
    botName: string;
    options: IRCConnectionOptions;
    server: string;
  }

  interface AppConfig {
    maintenanceMode: boolean;
    logger: LoggerFormat;
    qualifiedURL: string;
    devPort: number;
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

  interface ConfigModule extends AppConfig {
    get<T extends keyof AppConfig>(key: T): AppConfig[T];
    get<T = unknown>(key: string): T;
    has(key: keyof AppConfig | string): boolean;
    util?: {
      toObject(): AppConfig;
      cloneDeep?<T>(value: T): T;
    };
  }

  const config: ConfigModule;
  export type { AppConfig, HTTPSConfig, IRCConfig, IRCConnectionOptions, LoggerFormat, PostgresConfig, QuestionCaptchaConfig, SearchConfig, WebHookTargets, ConfigModule };
  export default config;
}
