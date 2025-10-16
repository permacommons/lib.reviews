/* global $, AC */
import AbstractAutocompleteAdapter from './abstract-autocomplete-adapter';
import { msg, repaintFocusedHelp } from '../libreviews.js';

/**
 * Perform book metadata lookups on openlibrary.org. Like other frontend
 * adapters, it is shallow and does not care for language, authorship,
 * or other details.
 *
 * @extends AbstractAutocompleteAdapter
 */
class OpenLibraryAutocompleteAdapter extends AbstractAutocompleteAdapter {

  /**
   * See {@link AbstractAutocompleteAdapter} for parameter documentation, not
   * shown here due to [jsdoc bug](https://github.com/jsdoc3/jsdoc/issues/1012).
   *
   * @inheritdoc
   */
  constructor(updateCallback, searchBoxSelector) {
    super(updateCallback, searchBoxSelector);

    // Standard adapter settings
    this.sourceID = 'openlibrary';
    this.supportedPattern = new RegExp('^https*://openlibrary.org/(works|books)/(OL[^/.]+)(?:/(?:.*))*$', 'i');

    /**
     * How many results to get per query. This is pretty low since a result
     * takes up a fair amount of space in the UI, esp. on mobile.
     *
     * @type {Number}
     */
    this.limit = 6;
  }


  /**
   * Obtain data from Open Library for a given URL.
   *
   * @param {String} url
   *  URL to an Open Library book or work
   * @returns {Promise}
   *  resolves to a {@link LookupResult} if successful, rejects with an error
   *  if not
   */
  lookup(url) {
    return new Promise((resolve, reject) => {
      let m = url.match(this.supportedPattern);
      if (m === null)
        return reject(new Error('URL does not appear to reference an Open Library work or edition.'));

      // Open Library distinguishes works and editions. Editions contain
      // significantly more metadata and are generally preferred. We cannot
      // guess the edition, however -- even if only on 1 exists in Open Library,
      // others may exist in the world.
      let isEdition = m[1] == 'books';

      // The string at the end of the original URL must be strpiped off for
      // obtaining the JSON representation.
      let jsonURL = isEdition ? `https://openlibrary.org/books/${m[2]}.json` :
        `https://openlibrary.org/works/${m[2]}.json`;

      $.get(jsonURL)
        .done(data => {
          // We need at least a label to work with
          if (typeof data !== 'object' || !data.title)
            return reject(new Error('Result from Open Library did not include a work or edition title.'));

          let label = data.title,
            subtitle = data.subtitle;
          resolve({
            data: {
              label,
              subtitle
            },
            sourceID: this.sourceID
          });
        })
        .fail(reject);
    });
  }


  /**
   * Merge results from two Open Library search queries into a single array.
   * The overall size will not exceed `this.limit`.
   *
   * @param {array} results - set of results from two or more search queries
   * @returns {array} de-duplicated result array
   */
  mergeResults(results) {
    let data = {
      docs: []
    };
    let knownKeys = [];

    for (let result of results) {
      if (typeof result == 'object' && result.docs && result.docs.length) {
        for (let doc of result.docs) {
          if (!knownKeys.includes(doc.key) && data.docs.length < this.limit) {
            data.docs.push(doc);
            knownKeys.push(doc.key);
          }
        }
      }
    }
    return data;
  }

  /**
   * Perform an in-place sort on results from a search query, putting any
   * exact matches against the query first
   *
   * @param {Array} docs - "docs" array from the Open Library JSON search API
   * @param {String} query - original query text that yielded this result
   */
  sortMatches(docs, query) {
    let hasExact = str => str.toUpperCase().indexOf(query.toUpperCase()) != -1;
    docs.sort((a, b) => {
      if (typeof a != 'object' || typeof b != 'object' ||
        a.title === undefined || b.title === undefined)
        return 0;

      if (hasExact(a.title) && !hasExact(b.title))
        return -1;
      else if (!hasExact(a.title) && hasExact(b.title))
        return 1;
      else
        return 0;
    });
  }


  /**
   * Render callback for the autocomplete widget. For each result, we show
   * authorship and edition information, which goes a bit beyond what we
   * could cram into the default rendering.
   *
   * @param {Object} row
   *  row data object as obtained via
   *  {@link OpenLibraryAutocompleteAdapter#_requestHandler}
   * @returns {Element}
   *  the element to insert into the DOM for this row
   * @this OpenLibraryAutocompleteAdapter#ac
   */
  _renderRowHandler(row) {
    // Row-level CSS gets added by library
    let $el = $('<div>');
    $('<span>')
      .addClass(this.getCSS('PRIMARY_SPAN'))
      .append($(AC.createMatchTextEls(this.value,
        row[this.primaryTextKey])))
      .appendTo($el);

    let description = '';
    let hasAuthor = row.authors && row.authors.length;
    if (hasAuthor) {
      let authorList = row.authors.join(', ');
      description += `<b>${authorList}</b>`;
    }

    let edNum = row.publishers ? row.publishers.length : 0;

    if (edNum) {
      if (hasAuthor)
        description += '<br>';

      let yearStr;
      if (row.years && row.years.length) {
        let minYear = Reflect.apply(Math.min, this, row.years);
        let maxYear = Reflect.apply(Math.max, this, row.years);
        // Different languages may express ranges differently, use different
        // whitespace, etc., so the message is substituted into the main
        // message.
        yearStr = minYear == maxYear ?
          msg('single year', { stringParam: minYear }) :
          msg('year range', { numberParams: [minYear, maxYear] });
      } else
        yearStr = msg('single year', { stringParam: msg('unknown year') });

      if (edNum == 1)
        description += msg('one edition', { stringParam: yearStr });
      else
        // Pass along number of editions
        description += msg('multiple editions', { numberParam: edNum, stringParam: yearStr });
    }

    if (description) {
      $('<span>')
        .addClass(this.getCSS('SECONDARY_SPAN'))
        .html(description)
        .appendTo($el);
    }
    return $el[0];
  }


  /**
   * Query the Open Library's main search endpoint for this search string,
   * store the results in the instance of the autocomplete widget, and render
   * them.
   *
   * Fires off two requests per query to perform both a stemmed search and a
   * wildcard search. Optionally also supports author searches if split off
   * from main query string with ";".
   *
   * @param  {String} query
   *  the unescaped query string
   * @this OpenLibraryAutocompleteAdapter#ac
   */
  _requestHandler(query) {
    let time = Date.now();

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

    // Lucene special characters
    query = query.replace(/(["+\-~![\]^\\&|(){}])/g, '\\$&');

    // Inconsistent behavior, best to strip
    query = query.replace(/:/g, '');

    // Turn double or more spaces into single spaces
    query = query.replace(/ {2,}/g, ' ');

    // We allow combining author and title search by adding an author w/ ";"
    let titleComponent = query,
      authorComponent = '',
      titleQuery = '',
      authorQuery = '',
      authorStart = titleComponent.indexOf(';'),
      hasAuthorComponent = authorStart != -1; // Single semicolon doesn't count

    if (hasAuthorComponent) {
      authorComponent = query.substr(authorStart + 1).trim();
      titleComponent = query.substr(0, query.length - (authorComponent.length + 1)).trim();
    }

    if (titleComponent)
      titleQuery = titleComponent.split(' ').map(word => `title:${word}`).join(' AND ');
    if (authorComponent) {
      authorQuery = authorComponent.split(' ').map(word => `author:${word}`).join(' AND ');
      if (titleQuery)
        authorQuery = ' ' + authorQuery;

      // All author searches get wildcarded. Since the author field does not
      // appear to be stemmed, this matches both partial and complete names.
      authorQuery += '*';
    }
    let q = titleQuery + authorQuery;
    let queryObj = {
      q,
      limit: this.adapter.limit,
      mode: 'everything'
    };

    let queryObj2;
    // Add a second wildcard query for longer searches. This may produce 0
    // results due to stemming conflicts, so we still have to fire off the
    // other query, as well.
    if (titleComponent.length >= 3 || authorComponent.length >= 3) {
      let q2 = titleQuery;
      if (titleComponent.length >= 3)
        q2 += '*';

      q2 += authorQuery;

      // if (authorComponent.length >= 3)
      //   q2 += '*';
      queryObj2 = Object.assign({}, queryObj);
      queryObj2.q = q2;
    }

    let getQuery = queryObj => new Promise((resolve, reject) => {
      $.ajax({
          url: 'https://openlibrary.org/search.json',
          dataType: 'json',
          data: queryObj
        })
        .done(resolve)
        .fail(reject);
    });

    let queries = [getQuery(queryObj)];

    if (queryObj2)
      queries.push(getQuery(queryObj2));

    Promise
      .all(queries)
      .then(results => {

        // Eliminate duplicate keys and merge results into a single array
        let data = this.adapter.mergeResults(results);

        // Rank any exact matches of the query string first (in-place sort)
        this.adapter.sortMatches(data.docs, query);

        // Don't update if a more recent query has superseded this one
        if (time < this.latestQuery)
          return;

        this.results = [];

        if (typeof data === 'object' && data.docs && data.docs.length) {
          this.results = data.docs.map(item =>
            ({
              url: `https://openlibrary.org${item.key}`,
              label: item.title,
              authors: item.author_name,
              publishers: item.publisher || [],
              years: item.publish_year || []
            }));
          this.render();
        } else {
          this.render();
          this.renderNoResults();
        }
        this.adapter.disableSpinner();
      })
      .catch(_error => {
        // Show generic error
        $('#generic-action-error').removeClass('hidden');
        repaintFocusedHelp();
        // Turn off spinner
        this.adapter.disableSpinner();
      });
  }

}

export default OpenLibraryAutocompleteAdapter;
