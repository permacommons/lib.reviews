import 'jquery';

// Augment jQuery plugin types via global interfaces instead of module augmentation.
// This avoids the "resolves to a non-module entity" error with @types/jquery.

declare global {
  interface Sisyphus {
    manuallyReleaseData(): void;
    saveAllData(): void;
  }

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

  interface JQueryStatic {
    modal: {
      BEFORE_CLOSE: string;
      close(): void;
    };
  }
}

export {};
