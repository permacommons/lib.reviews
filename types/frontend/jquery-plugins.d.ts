import 'jquery';

/**
 * Augment jQuery plugin types via global interfaces instead of module
 * augmentation. This avoids the "resolves to a non-module entity" error with
 * `@types/jquery` while giving our legacy jQuery widgets some type safety.
 */

declare global {
  /**
   * API surface exposed by the Sisyphus form autosave plugin used by the
   * review editor for draft persistence (see `frontend/review.ts`).
   */
  interface Sisyphus {
    manuallyReleaseData(): void;
    saveAllData(): void;
  }

  /**
   * Plugin extensions invoked by our jQuery-based forms and dialog helpers.
   */
  interface JQuery<TElement = HTMLElement> {
    getEmptyInputs(): JQuery<TElement>;
    highlightLabels(indicatorSelector?: string): JQuery<TElement>;
    attachRequiredFieldHandler(options?: {
      indicatorSelector?: string;
      requiredFieldMessage?: string;
      formErrorMessage?: string;
      formSelector?: string;
      validationErrorSelector?: string;
      callback?: (this: HTMLElement, event: JQuery.Event) => void;
    }): JQuery<TElement>;
    lockTab(): JQuery<TElement>;
    toggleSwitcher(): JQuery<TElement>;
    conditionalSwitcherClick(
      handler: (this: HTMLElement, event: JQuery.Event) => void
    ): JQuery<TElement>;
    powerTip(options?: {
      placement?: 'n' | 's' | 'e' | 'w';
      smartPlacement?: boolean;
      mouseOnToPopup?: boolean;
    }): JQuery<TElement>;
    modal(options?: {
      escapeClose?: boolean;
      clickClose?: boolean;
      showClose?: boolean;
    }): JQuery<TElement>;
    sisyphus(options?: {
      onBeforeRestore?: () => void;
      onRestore?: () => void;
      excludeFields?: JQuery;
    }): Sisyphus;
  }

  /**
   * Static helpers injected by `jquery-modal` when the modal dialog plugin is
   * loaded.
   */
  interface JQueryStatic {
    modal: {
      BEFORE_CLOSE: string;
      close(): void;
    };
  }
}

export {};
