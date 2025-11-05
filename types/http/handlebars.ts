import type { HelperOptions } from 'handlebars';

import type { TemplateContext } from './locals.ts';

export type HelperOptionsWithRoot = HelperOptions & {
  data?: HelperOptions['data'] & { root: TemplateContext };
};

declare module 'handlebars' {
  interface HelperOptions {
    data?: HelperOptions['data'] & { root: TemplateContext };
  }
}
