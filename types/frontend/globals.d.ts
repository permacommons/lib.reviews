/**
 * Global type definitions for browser code compiled out of `frontend/`.
 */

/**
 * Shape of the `window.config` object emitted by `routes/helpers/render.ts` and
 * consumed by entry points like `frontend/review.ts`.
 */
export interface FrontendConfig {
  editing?: boolean;
  language?: string;
  messages?: Record<string, string>;
  illegalUsernameCharacters?: string;
  userID?: string;
  isTrusted?: boolean;
  userPrefersRichTextEditor?: boolean;
}

declare global {
  /**
   * Globals injected into the browser runtime.
   */
  interface Window {
    config: FrontendConfig;
    libreviews?: import('../../frontend/libreviews').LibreviewsAPI;
  }

  /**
   * Global config object passed from the server render pipeline.
   */
  const config: FrontendConfig;
}

export {};
