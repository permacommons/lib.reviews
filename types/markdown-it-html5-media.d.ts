declare module 'markdown-it-html5-media' {
  import type { PluginWithOptions } from 'markdown-it';

  /**
   * Options accepted by the markdown-it HTML5 media plugin. The translation
   * callback is wired up by `util/md.ts` to localize captions.
   */
  export interface Html5MediaOptions {
    translateFn?: (
      locale: string | undefined,
      messageKey: string,
      messageParams?: unknown[]
    ) => string;
  }

  /** Plugin factory consumed by `util/md.ts` and editor entry points. */
  export const html5Media: PluginWithOptions<Html5MediaOptions>;
  /** Utility exported by the plugin for media inference used in `frontend/editor-menu.ts`. */
  export function guessMediaType(src: string): 'audio' | 'video' | 'image';
}
