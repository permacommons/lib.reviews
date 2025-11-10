import type { HelperOptions } from 'handlebars';

import type { TemplateContext } from './locals.ts';

/**
 * Helper options enriched with the template context so helpers can access the
 * same locals as Express views (see `util/handlebars-helpers.ts`).
 */
export type HelperOptionsWithRoot = HelperOptions & {
  data?: HelperOptions['data'] & { root: TemplateContext };
};

declare module 'handlebars' {
  /**
   * Extend Handlebars helper options so `.data.root` matches our template
   * context, enabling typed access inside helper implementations.
   */
  interface HelperOptions {
    data?: HelperOptions['data'] & { root: TemplateContext };
  }
}
