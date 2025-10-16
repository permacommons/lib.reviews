/* global $, AC */
import AbstractLookupAdapter from './abstract-lookup-adapter';
import NativeLookupAdapter from './native-lookup-adapter';
import { msg } from '../libreviews.js';
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
export default class AbstractAutocompleteAdapter extends AbstractLookupAdapter {

  /**
   * @param {Function} updateCallback - Callback to run after a row has been
   *  selected.
   * @param {String} searchBoxSelector - jQuery selector for input we're adding
   *  the autocomplete widget to.
   */
  constructor(updateCallback, searchBoxSelector) {
    super(updateCallback);

    if (this.constructor.name === AbstractAutocompleteAdapter.name)
      throw new TypeError('AbstractAutocompleteAdapter is an abstract class, please instantiate a derived class.');

    this.searchBoxSelector = searchBoxSelector;

    /**
     * Delay in milliseconds before performing a search.
     *
     * @type {Number}
     */
    this.acDelay = 300;

    /**
     * CSS prefix for the autocomplete widget.
     *
     * @type {String}
     */
    this.acCSSPrefix = 'ac-adapter-';

    /**
     * Key (into the `row` objects retrieved via the request handler)
     * that determines which value is used as the main text in the autocomplete
     * widget.
     *
     * `'label'` corresponds to what the main application expects, but if you
     * want to show something different than what gets passed to the
     * application, you may want to change it.
     *
     * @type {String}
     */
    this.acPrimaryTextKey = 'label';

    /**
     * Default row key for the optional secondary, smaller text shown in the
     * autocomplete widget below each result.
     *
     * @type {String}
     */
    this.acSecondaryTextKey = 'description';

    /**
     * Callback for fetching row data.
     *
     * @function
     * @abstract
     * @this AbstractAutocompleteAdapter#ac
     * @param {String} query - The characters entered by the user
     */
    this._requestHandler = this._requestHandler || null;

    /**
     * Callback for rendering a row within the autocomplete widget, overriding
     * default rendering.
     *
     * @function
     * @abstract
     * @this AbstractAutocompleteAdapter#ac
     * @param {Object} row - The row object to render
     *
     */
    this._renderRowHandler = this._renderRowHandler || null;
  }

  /**
   * Initialize the autocomplete widget. You can add additional callbacks /
   * custom properties in the inherited class; just remember to call
   * `super.setupAutocomplete()` first.
   */
  setupAutocomplete() {
    let ac = new AC($(this.searchBoxSelector)[0]);
    ac.primaryTextKey = this.acPrimaryTextKey;
    ac.secondaryTextKey = this.acSecondaryTextKey;
    ac.delay = this.acDelay;
    ac.cssPrefix = this.acCSSPrefix;
    ac.adapter = this;

    // Register standard callbacks
    if (this._requestHandler)
      ac.requestFn = this._requestHandler.bind(ac);

    if (this._selectRowHandler)
      ac.triggerFn = this._selectRowHandler.bind(ac);

    if (this._renderRowHandler)
      ac.rowFn = this._renderRowHandler.bind(ac);

    // Custom function for showing "No results" text
    ac.renderNoResults = this._renderNoResultsHandler.bind(ac);

    /**
     * After {@link AbstractAutocompleteAdapter#setupAutocomplete} is run,
     * holds a reference to the autocomplete widget used by this instance.
     *
     * @type {AC}
     * @member
     */
    this.ac = ac;
  }

  /**
   * Remove the autocomplete widget including all its event listeners.
   */
  removeAutocomplete() {
    if (this.ac) {
      this.ac.deactivate();
      this.ac = undefined;
    }
  }

  /**
   * Run the autocomplete widget on the current input.
   */
  runAutocomplete() {
    if (this.ac) {
      this.ac.inputEl.focus();
      this.ac.inputHandler();
    }
  }

  /**
   * Show activity indicator in the input widget. Must be called in handler
   * code via this.adapter.
   */
  enableSpinner() {
    $(`${this.searchBoxSelector} + span.input-spinner`).removeClass('hidden');
  }

  /**
   * Hide activity indicator in the input widget. Must be called in handler
   * code via this.adapter.
   */
  disableSpinner() {
    $(`${this.searchBoxSelector} + span.input-spinner`).addClass('hidden');
  }


  /**
   * Pass along row data we can handle to the main application. Will also
   * query lib.reviews itself (through the native adapter) for the URL, so
   * we can give preferential treatment to an existing native record for the
   * review subject.
   *
   * @this AbstractAutocompleteAdapter#ac
   * @param {Object} row
   *  row data object. All properties except "url" are only used for display
   *  purposes, since the server performs its own lookup on the URL.
   * @param {String} row.url
   *  the URL for this review subject
   * @param {String} row.label
   *  the main name shown for this review subject
   * @param {String} [row.subtitle]
   *  shown as secondary title for the subject
   * @param {String} [row.description]
   *  shown as short description below label and subtitle
   * @param {Event} event
   *  the click or keyboard event which triggered this row selection.
   */
  _selectRowHandler(row, event) {
    event.preventDefault();
    if (row.url && row.label) {
      const data = {
        label: row.label,
        url: row.url
      };
      if (row.subtitle)
        data.subtitle = row.subtitle;
      if (row.description)
        data.description = row.description;

      // Let the application perform appropriate updates based on this data
      this.adapter.updateCallback(data);

      // Check if we have local record and if so, replace lookup results
      nativeLookupAdapter
        .lookup(row.url)
        .then(result => {
          if (result && result.data) {
            result.data.url = row.url;
            this.adapter.updateCallback(result.data);
          }
        })
        .catch(() => {
          // Do nothing
        });
    }
  }

  /**
   * Render "No search results" text row at the bottom with default styles.
   *
   * @this AbstractAutocompleteAdapter#ac
   */
  _renderNoResultsHandler() {
    const $wrapper = $(this.rowWrapperEl);
    const $noResults = $('<div class="ac-adapter-no-results">' + msg('no search results') + '</div>');
    $wrapper
      .append($noResults)
      .show();
  }

}
