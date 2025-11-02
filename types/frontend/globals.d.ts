/**
 * Global type definitions for frontend code
 */

/**
 * Frontend config object structure
 */
export interface FrontendConfig {
  editing?: boolean;
  language?: string;
  messages?: Record<string, string>;
  illegalUsernameCharacters?: string;
  userID?: string;
}

declare global {
  interface Window {
    config: FrontendConfig;
    libreviews?: import('../../frontend/libreviews').LibreviewsAPI;
  }

  /**
   * Global config object passed from server
   */
  const config: FrontendConfig;
}

export {};
