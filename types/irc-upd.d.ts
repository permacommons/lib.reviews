declare module 'irc-upd' {
  import type { EventEmitter } from 'node:events';
  import type { IRCConnectionOptions } from 'config';

  /**
   * Thin wrapper around the IRC client constructor used by the webhook bridge
   * in `tools/irc-bot.ts`.
   */
  class Client extends EventEmitter {
    constructor(server: string, nickname: string, options: IRCConnectionOptions);
    nick: string;
    say(target: string, message: string): void;
    once(event: 'names', listener: () => void): this;
    once(event: string, listener: (...args: unknown[]) => void): this;
  }

  /** Module shape returned by `import irc from 'irc-upd'`. */
  interface IrcModule {
    Client: typeof Client;
  }

  const irc: IrcModule;
  export { Client };
  export default irc;
}
