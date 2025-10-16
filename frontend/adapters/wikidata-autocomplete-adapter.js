/* global $, config */
import AbstractAutocompleteAdapter from './abstract-autocomplete-adapter';
import { msg as libreviewsMsg, repaintFocusedHelp } from '../libreviews.js';

/**
 * This module performs shallow lookups on Wikidata. They are shallow in that
 * they only load the information that needs to be displayed to the user in
 * their current language. The backend version of this adapter performs the
 * actual deep lookup for all languages.
 *
 * @extends AbstractAutocompleteAdapter
 */
class WikidataAutocompleteAdapter extends AbstractAutocompleteAdapter {

  /**
   * See {@link AbstractAutocompleteAdapter} for parameter documentation, not
   * shown here due to [jsdoc bug](https://github.com/jsdoc3/jsdoc/issues/1012).
   *
   * @inheritdoc
   */
  constructor(updateCallback, searchBoxSelector) {
    super(updateCallback, searchBoxSelector);
    // Adapter settings
    this.sourceID = 'wikidata';
    this.supportedPattern = new RegExp('^http(s)*://(www.)*wikidata.org/(entity|wiki)/(Q\\d+)(?:#.*)?$', 'i');
    this.apiBaseURL = 'https://www.wikidata.org/w/api.php';
    this.queryServiceBaseURL = 'https://query.wikidata.org/bigdata/namespace/wdq/sparql';

    /**
     * Because we exclude certain item classes (e.g., disambiguation pages), we
     * fetch a larger number of results than we may need, since we may eliminate
     * some of them. The ratio configured here has proven to strike a good
     * balance where few queries result in zero "good" results.
     *
     * @type {Number}
     */
    this.fetchResults = 25;

    /**
     * @see WikidataAutocompleteAdapter#fetchResults
     * @type {Number}
     */
    this.displayResults = 7;


    /**
     * Timeout for query service validation requests in milliseconds
     *
     * @type {Number}
     */
    this.queryServiceTimeout = 5000;

    /**
     * Items with these classes are typically not going to be the target of
     * reviews.
     *
     * @type {String[]}
     */
    this.excludedItemClasses = [
      'Q4167410', // disambiguation page
      'Q17633526', // Wikinews article
      'Q11266439', // Template
      'Q4167836', // Category
      'Q14204246' // Wikimedia project page
    ];

    /**
     * How do lib.reviews language code translate to Wikidata language codes?
     * lib.reviews language code are used as keys, Wikidata codes as values.
     *
     * Since Wikidata supports a superset of languages and most language code
     * are identical, we only enumerate exceptions.
     *
     * @type {Object}
     */
    this.nativeToWikidata = {
      pt: 'pt-br',
      'pt-PT': 'pt'
    };

  }


  /**
   * Look up a single item in Wikidata given its URL. Uses the MediaWiki API.
   *
   * @param  {String} url
   *  the URL to look up
   * @returns {Promise}
   *  resolves to a {@link LookupResult} if successful, rejects with
   *  error if not.
   */
  lookup(url) {
    return new Promise((resolve, reject) => {
      let qNumber = (url.match(this.supportedPattern) || [])[4];
      if (!qNumber)
        return reject(new Error('URL does not appear to contain a Q number (e.g., Q42) or is not a Wikidata URL.'));

      // in case the URL had a lower case "q"
      qNumber = qNumber.toUpperCase();

      let language = this.nativeToWikidata[config.language] || config.language;
      language = language.toLowerCase();

      let queryObj = {
        action: 'wbgetentities',
        format: 'json',
        languages: language,
        uselang: language,
        languagefallback: 1,
        props: 'labels|descriptions',
        ids: qNumber
      };

      $.get({
          url: this.apiBaseURL,
          jsonp: 'callback',
          dataType: 'jsonp',
          data: queryObj
        })
        .done(data => {
          if (typeof data !== 'object' || !data.success || !data.entities || !data.entities[qNumber])
            return reject(new Error('Did not get a valid Wikidata entity for query: ' + qNumber));

          // Descriptions result will be an empty object if no description is available, so
          const entity = data.entities[qNumber];
          // will always pass this test
          if (!entity.labels || !entity.descriptions)
            return reject(new Error('Did not get label and description information for query: ' + qNumber));

          if (!entity.labels[language])
            return reject(new Error('Did not get a label for ' + qNumber + 'for the specified language: ' + language));

          let label = entity.labels[language].value,
            description;

          if (entity.descriptions[language])
            description = entity.descriptions[language].value;

          resolve({
            data: {
              label,
              description
            },
            sourceID: this.sourceID
          });
        })
        .fail(reject);
    });
  }

  setupAutocomplete() {
    super.setupAutocomplete();

    /**
     * We override the default, because we may display different text (stored
     * in this field) than what we pass along to the application (stored in the
     * label field). The display text may include a parenthetical component that
     * highlights a match against an alias, rather than the primary label.
     *
     * @type {String}
     * @alias WikidataAutocompleteAdapter#acPrimaryTextKey
     */
    this.ac.primaryTextKey = 'title';

    /**
     * We override the default; Wikidata can take more of a beating than some
     * other sites. :)
     *
     * @type {Number}
     * @alias WikidataAutocompleteAdapter#acDelay
     */
    this.ac.delay = 0;

    this.ac.renderNav = this._renderNavHandler.bind(this.ac);
    this.ac.extractRow = this._extractRowHandler.bind(this.ac);
  }

  /**
   * Send an autocomplete request to the Wikidata query service and render
   * the result using the autocomplete widget.
   *
   * @param {String} query
   *  the query string
   * @param {Number} [offset]
   *  the offset from which to continue a previous query.
   */
  _requestHandler(query, offset) {

    const time = Date.now();

    // Keep track of most recently fired query so we can ignore responses
    // coming in late
    if (this.latestQuery === undefined || this.latestQuery < time)
      this.latestQuery = time;

    this.results = [];
    query = query.trim();

    // Nothing to do - clear out the display & abort
    if (!query) {
      this.adapter.disableSpinner();
      this.render();
      return;
    }

    // Turn on spinner
    this.adapter.enableSpinner();

    const language = this.adapter.nativeToWikidata[config.language] || config.language;

    // Build union filter of excluded item classes
    const excludedClassesStr = this.adapter.excludedItemClasses.reduce((str, qNumber) => {
      if (!str)
        str = `{ ?item wdt:P31 wd:${qNumber} }`;
      else
        str += `\n      UNION { ?item wdt:P31 wd:${qNumber} }`;
      return str;
    }, '');

    let offsetStr = '',
      isFirstPage;

    if (offset) {
      offsetStr = `bd:serviceParam mwapi:continue ${offset} .\n`;
      isFirstPage = false;
    } else {
      isFirstPage = true;
      // Keep track of the exact offsets used on previous pages, since
      // they vary due to client-side filtering
      this.prevStack = [];
    }

    // String will be inside quotes, so let's make sure it can't get out :)
    const escapedQuery = query.replace(/(["\\])/g, '\\$&');

    // See https://www.mediawiki.org/wiki/Wikidata_query_service/User_Manual/MWAPI
    // for more info about what's going on here.
    const sparqlQuery = `SELECT * WHERE {
     FILTER NOT EXISTS {
      ${excludedClassesStr}
      }  SERVICE wikibase:mwapi {
          bd:serviceParam wikibase:api "EntitySearch" .
          bd:serviceParam wikibase:endpoint "www.wikidata.org" .
          bd:serviceParam mwapi:search "${escapedQuery}" .
          bd:serviceParam mwapi:language "${language}" .
          bd:serviceParam mwapi:uselang "${language}" .
          bd:serviceParam mwapi:limit ${this.adapter.fetchResults} .
          ${offsetStr}
          ?item wikibase:apiOutputItem mwapi:item .
          ?url wikibase:apiOutput "@url" .
          ?label wikibase:apiOutput "@label" .
          ?matchText wikibase:apiOutput "match/@text"  .
          ?description wikibase:apiOutput "@description" .
          ?ordinal wikibase:apiOrdinal true
        }
    }
    ORDER BY ?ordinal`;

    $.get({
        url: this.adapter.queryServiceBaseURL,
        dataType: 'json',
        data: {
          query: sparqlQuery,
          format: 'json'
        },
        timeout: this.adapter.queryServiceTimeout
      })
      .done(data => {
        // Don't update if a more recent query has superseded this one
        if (time < this.latestQuery)
          return;

        this.adapter.disableSpinner();
        this.results = [];

        if (typeof data !== 'object' || !data.results ||
          !data.results.bindings || !data.results.bindings.length) {
          // Render blank results and error, abort
          this.render();
          this.renderNoResults();
          return;
        }
        let i = 0;
        for (let item of data.results.bindings) {
          this.results.push(this.extractRow(item, query));
          i++;
          if (i == this.adapter.displayResults)
            break;
        }
        this.render();


        // Remember we intentionally tell the MW API to send a bit more than we
        // need, since some of it may have been filtered out by the SPARQL
        // query conditions. If we still got back more than we display, we
        // can now render the pagination. Alternatively, if this is already
        // a pagination request, the user should be able to go back as well :)
        const thereAreMoreResults = data.results.bindings.length >
          this.adapter.displayResults;

        if (thereAreMoreResults || !isFirstPage)
          this.renderNav({
            thereAreMoreResults,
            isFirstPage,
            bindings: data.results.bindings,
            offset,
            queryString: query
          });

      })
      .fail(_error => {
        // Show generic error
        $('#generic-action-error').removeClass('hidden');
        repaintFocusedHelp();
        // Turn off spinner
        this.adapter.disableSpinner();
      });
  }


  /**
   * Transform a result from the Wikidata item into a row that can be rendered
   * by the autocomplete widget.
   *
   * @param {Object} item
   *  a query result returned by the SPARQL query service (member of `bindings`
   *  array)
   * @param {String} queryString
   *  the original (unescaped) query string is used for highlighting the match
   *  in a composite title that includes both the label and the alias against
   *  which the query matched
   * @returns {Object}
   *  plain object that only contains the data we can use inside the
   *  application, plus a derived `title` property for rendering this row in
   *  the autocomplete widget.
   *
   * @this WikidataAutocompleteAdapter#ac
   */
  _extractRowHandler(item, queryString) {
    let row = {};
    row.url = `https:${item.url.value}`; // Returned URL is protocol relative

    if (item.label)
      // Title may be modified below
      row.title = row.label = item.label.value;

    if (item.description)
      row.description = item.description.value;


    // If the result does not contain the query string directly, but some
    // other part of the item such as its aliases returned a match, we
    // include the match in the rendered result (similar to the Wikidata.org
    // search box).
    const isInexactMatch = typeof row.title == 'string' &&
      row.title.toUpperCase().indexOf(queryString.toUpperCase()) == -1;

    if (isInexactMatch && item.matchText)
      row.title += ` (${item.matchText.value})`;
    else if (!row.title && item.matchText)
      row.title = item.matchText.value;

    return row;
  }


  /**
   * Render next/previous navigation within the autocomplete widget.
   *
   * @param {Object} spec
   *  Navigation settings
   * @param {Boolean} spec.isFirstPage
   *  First page of results doesn't get a "previous page" icon and click handler
   *  that calls {@link WikidataAutocompleteAdapter#_requestHandler} (previously
   *  loaded results are not cached)
   * @param {Boolean} spec.thereAreMoreResults
   *  If true, render "next page" icon and attach click handler that calls
   *  request handler
   * @param {Array} spec.bindings
   *  the `bindings` property of a Wikidata query service result from a SPARQL
   *  query - this contains the actual search result data
   * @param {Number} spec.offset
   *  the offset that was used for the search we're rendering navigation for
   * @param {String} spec.queryString
   *  the original (unescaped) query string, used by the click handler to
   *  fire off subsequent requests
   * @this WikidataAutocompleteAdapter#ac
   */
  _renderNavHandler(spec) {

    const {
      isFirstPage,
      thereAreMoreResults,
      bindings,
      offset,
      queryString
    } = spec;

    // CSS classes for template
    const css = {
      prev: 'ac-adapter-get-prev',
      next: 'ac-adapter-get-next',
      wrap: 'ac-adapter-get-more',
      more: 'ac-adapter-more-results',
      active: 'ac-adapter-get-active',
      left: "fa fa-caret-left", // icon
      right: "fa fa-caret-right"
    };

    // Access keys for navigation
    const keys = {
      prev: '<',
      next: '>'
    };

    //  UI messages
    const msg = {
      more: libreviewsMsg('more results'),
      prev: libreviewsMsg('load previous page', { accessKey: keys.prev }),
      next: libreviewsMsg('load next page', { accessKey: keys.next })
    };

    // Templates
    const $navPlaceholder = $(`<div class="${css.prev}">&nbsp;</div>`),
      $navWrapper =
      $(`<div class="${css.wrap}"></div>`),
      $navMoreResultsText =
      $(`<div class="${css.more}">${msg.more}</div>`),
      $navPreviousPage =
      $(`<div accesskey="${keys.prev}" class="${css.prev} ${css.active}" ` +
        `title="${msg.prev}"><span class="${css.left}">&nbsp;</span></div>`),
      $navNextPage =
      $(`<div class="${css.next} ${css.active}" accesskey="${keys.next}" ` +
        `title="${msg.next}"><span class="${css.right}">&nbsp;</span></div>`);

    const $wrapper = $(this.rowWrapperEl),
      $getMore = $navWrapper.appendTo($wrapper);

    // Add "previous page" navigation
    if (!isFirstPage) {
      $navPreviousPage
        .appendTo($getMore)
        .click(() => this.requestFn(queryString, this.prevStack.pop()));
    }

    // The query helpfully returns an ordinal, the position of the result in
    // the result set _before_ the filter criteria (disambig pages etc.) are
    // applied. We can just continue from there.
    if (thereAreMoreResults) {
      const nextOffset = (offset || 0) +
        +bindings[this.adapter.displayResults].ordinal.value;

      // Add whitespace placeholder
      if (isFirstPage)
        $navPlaceholder
        .appendTo($getMore);

      // Add "MORE RESULTS" centered text
      $navMoreResultsText
        .appendTo($getMore);

      // Add "next page" navigation
      $navNextPage
        .appendTo($getMore)
        .click(() => {
          this.prevStack.push(offset);
          this.requestFn(queryString, nextOffset);
        });
    } else if (!isFirstPage) {
      // Add "MORE RESULTS" centered text
      $navMoreResultsText
        .appendTo($getMore);
    }
  }

}

export default WikidataAutocompleteAdapter;
