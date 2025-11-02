/* global $ */
import AbstractLookupAdapter from './abstract-lookup-adapter.js';
import NativeLookupAdapter from './native-lookup-adapter.js';
import { msg } from '../libreviews.js';
import type { UpdateCallback, UpdateCallbackData } from '../../types/frontend/adapters.js';
import type Autocomplete from '../lib/ac.js';

const nativeLookupAdapter = new NativeLookupAdapter();

/**
 * Adapter that handles ordinary URL lookup (as specified in
 * AbstractLookupAdapter) and autocomplete searches. Autocomplete searches
 * rely on the [remote-ac package](https://www.npmjs.com/package/remote-ac)
 * written by Danqing Liu.
 *
 * The autocomplete class (`AC` global) must exist before this code is run.
 * We communicate with the widget using callbacks, prefixed with `_`,
 * which are bound to it.
 *
 * @abstract
 * @extends AbstractLookupAdapter
 */
export default abstract class AbstractAutocompleteAdapter extends AbstractLookupAdapter {
  searchBoxSelector: string;

  /**
   * Delay in milliseconds before performing a search.
   */
  acDelay: number = 300;

  /**
   * CSS prefix for the autocomplete widget.
   */
  acCSSPrefix: string = 'ac-adapter-';

  /**
   * Key (into the `row` objects retrieved via the request handler)
   * that determines which value is used as the main text in the autocomplete
   * widget.
   *
   * `'label'` corresponds to what the main application expects, but if you
   * want to show something different than what gets passed to the
   * application, you may want to change it.
   */
  acPrimaryTextKey: string = 'label';

  /**
   * Default row key for the optional secondary, smaller text shown in the
   * autocomplete widget below each result.
   */
  acSecondaryTextKey: string = 'description';

  /**
   * After {@link AbstractAutocompleteAdapter#setupAutocomplete} is run,
   * holds a reference to the autocomplete widget used by this instance.
   */
  ac?: Autocomplete<any>;

  /**
   * Callback for fetching row data.
   *
   * @abstract
   * @param query - The characters entered by the user
   * @param offset - Optional offset for pagination
   */
  protected _requestHandler?(this: Autocomplete<any>, query: string, offset?: number): void;

  /**
   * Callback for rendering a row within the autocomplete widget, overriding
   * default rendering.
   *
   * @abstract
   * @param row - The row object to render
   */
  protected _renderRowHandler?(this: Autocomplete<any>, row: any): HTMLElement;

  /**
   * @param updateCallback - Callback to run after a row has been
   *  selected.
   * @param searchBoxSelector - jQuery selector for input we're adding
   *  the autocomplete widget to.
   */
  constructor(updateCallback: UpdateCallback | Function | null, searchBoxSelector: string) {
    super(updateCallback);

    if (this.constructor.name === AbstractAutocompleteAdapter.name)
      throw new TypeError('AbstractAutocompleteAdapter is an abstract class, please instantiate a derived class.');

    this.searchBoxSelector = searchBoxSelector;
  }

  /**
   * Initialize the autocomplete widget. You can add additional callbacks /
   * custom properties in the inherited class; just remember to call
   * `super.setupAutocomplete()` first.
   */
  setupAutocomplete(): void {
    const AC = (window as any).AC;
    const ac = new AC($(this.searchBoxSelector)[0]);
    ac.primaryTextKey = this.acPrimaryTextKey;
    ac.secondaryTextKey = this.acSecondaryTextKey;
    ac.delay = this.acDelay;
    ac.cssPrefix = this.acCSSPrefix;
    ac.adapter = this;

    // Register standard callbacks
    if (this._requestHandler)
      ac.requestFn = (this._requestHandler as any).bind(ac);

    if (this._selectRowHandler)
      ac.triggerFn = (this._selectRowHandler as any).bind(ac);

    if (this._renderRowHandler)
      ac.rowFn = (this._renderRowHandler as any).bind(ac);

    // Custom function for showing "No results" text
    ac.renderNoResults = this._renderNoResultsHandler.bind(ac);

    this.ac = ac;
  }

  /**
   * Remove the autocomplete widget including all its event listeners.
   */
  removeAutocomplete(): void {
    if (this.ac) {
      this.ac.deactivate();
      this.ac = undefined;
    }
  }

  /**
   * Run the autocomplete widget on the current input.
   */
  runAutocomplete(): void {
    if (this.ac) {
      this.ac.inputEl.focus();
      this.ac.inputHandler();
    }
  }

  /**
   * Show activity indicator in the input widget. Must be called in handler
   * code via this.adapter.
   */
  enableSpinner(): void {
    $(`${this.searchBoxSelector} + span.input-spinner`).removeClass('hidden');
  }

  /**
   * Hide activity indicator in the input widget. Must be called in handler
   * code via this.adapter.
   */
  disableSpinner(): void {
    $(`${this.searchBoxSelector} + span.input-spinner`).addClass('hidden');
  }

  /**
   * Pass along row data we can handle to the main application. Will also
   * query lib.reviews itself (through the native adapter) for the URL, so
   * we can give preferential treatment to an existing native record for the
   * review subject.
   *
   * @param row - row data object. All properties except "url" are only used
   *  for display purposes, since the server performs its own lookup on the URL.
   * @param event - the click or keyboard event which triggered this row selection.
   */
  protected _selectRowHandler(row: { url?: string; label?: string; subtitle?: string; description?: string }, event: Event): void {
    event.preventDefault();
    if (row.url && row.label) {
      const data: UpdateCallbackData = {
        label: row.label,
        url: row.url
      };
      if (row.subtitle)
        data.subtitle = row.subtitle;
      if (row.description)
        data.description = row.description;

      // Let the application perform appropriate updates based on this data
      (this as any).adapter.updateCallback(data);

      // Check if we have local record and if so, replace lookup results
      nativeLookupAdapter
        .lookup(row.url)
        .then(result => {
          if (result && result.data) {
            const updatedData: UpdateCallbackData = { ...result.data, url: row.url };
            (this as any).adapter.updateCallback(updatedData);
          }
        })
        .catch(() => {
          // Do nothing
        });
    }
  }

  /**
   * Render "No search results" text row at the bottom with default styles.
   */
  protected _renderNoResultsHandler(this: Autocomplete<any>): void {
    const $wrapper = $((this as any).rowWrapperEl);
    const $noResults = $('<div class="ac-adapter-no-results">' + msg('no search results') + '</div>');
    $wrapper
      .append($noResults)
      .show();
  }
}
