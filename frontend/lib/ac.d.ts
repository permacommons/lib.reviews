/**
 * Type definitions for the lib.reviews Autocomplete widget
 * Based on MIT-licensed remote-ac project
 */

export default class Autocomplete<T = any> {
  constructor(
    inputEl: HTMLElement | null,
    urlFn: ((query: string) => string) | null,
    requestFn: ((this: Autocomplete<T>, query: string, offset?: number) => void) | null,
    resultFn: ((data: any) => T[]) | null,
    rowFn: ((this: Autocomplete<T>, row: T) => HTMLElement) | null,
    triggerFn: ((this: Autocomplete<T>, result: T | null, event?: Event) => void) | null,
    anchorEl?: HTMLElement
  );

  inputEl: HTMLElement;
  anchorEl: HTMLElement;
  urlBuilderFn: ((query: string) => string) | null;
  requestFn: ((this: Autocomplete<T>, query: string, offset?: number) => void) | null;
  resultFn: ((data: any) => T[]) | null;
  rowFn: ((this: Autocomplete<T>, row: T) => HTMLElement) | null;
  triggerFn: ((this: Autocomplete<T>, result: T | null, event?: Event) => void) | null;

  primaryTextKey: string;
  secondaryTextKey: string;
  delay: number;
  minLength: number;
  cssPrefix: string;
  adapter: any;

  value: string;
  results: T[];
  rows: HTMLElement[];
  selectedIndex: number;
  isRightArrowComplete: boolean;
  isMounted: boolean;

  el: HTMLElement | null;
  rowWrapperEl: HTMLElement | null;
  latestQuery: number | undefined;

  activate(): void;
  deactivate(): void;
  mount(): void;
  unmount(): void;
  position(): void;
  render(): void;
  renderNoResults(): void;
  renderNav(spec: any): void;
  getCSS(suffix: string): string;
  inputHandler(): void;
  extractRow(item: any, query?: any): T;
  prevStack?: any[];

  static createMatchTextEls(query: string, text: string): HTMLElement[];
  static createEl(tag: string, className: string): HTMLElement;
  static isMobileSafari(): boolean;
}
