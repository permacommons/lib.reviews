import type { TemplateContext } from './locals.ts';

declare module 'handlebars' {
  interface HelperOptions {
    data?: HelperOptions['data'] & { root: TemplateContext };
  }
}
