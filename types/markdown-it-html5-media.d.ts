declare module 'markdown-it-html5-media' {
  import type { PluginWithOptions } from 'markdown-it';

  export interface Html5MediaOptions {
    translateFn?: (locale: string | undefined, messageKey: string, messageParams?: unknown[]) => string;
  }

  export const html5Media: PluginWithOptions<Html5MediaOptions>;
  export function guessMediaType(src: string): 'audio' | 'video' | 'image';
}
