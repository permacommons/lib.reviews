/* global $, config */
/* eslint prefer-reflect: "off" */

import { polyfill as es6PromisePolyfill } from 'es6-promise';
import NativeLookupAdapter from './adapters/native-lookup-adapter';
import OpenStreetMapLookupAdapter from './adapters/openstreetmap-lookup-adapter';
import WikidataAutocompleteAdapter from './adapters/wikidata-autocomplete-adapter';
import OpenLibraryAutocompleteAdapter from './adapters/openlibrary-autocomplete-adapter';
import libreviews, { msg, repaintFocusedHelp, trimInput, validateURL, urlHasSupportedProtocol } from './libreviews.js';

es6PromisePolyfill();

/**
 * Immediately invoked function expression that initializes various event
 * handlers that are part of the review form, including:
 * - management of client-side drafts
 * - "star rating" selector
 * - mode switcher for source selection and integration with lookup adapters
 *
 * @namespace Review
 */
(function() {

  'use strict';

  // All adapters will be tried against a provided review subject URL. If they
  // support it, they will perform a parallel, asynchronous lookup. The array order
  // matters in that the first element in the array (not the first to return
  // a result) will be used for the review subject metadata. The native (lib.reviews)
  // lookup therefore always takes precedence.
  const adapters = [
    new NativeLookupAdapter(),
    new OpenStreetMapLookupAdapter(),
    new WikidataAutocompleteAdapter(updateURLAndReviewSubject, '#review-search-database'),
    new OpenLibraryAutocompleteAdapter(updateURLAndReviewSubject, '#review-search-database')
  ];

  /**
   * URL of the most recently used lookup from an adapter.
   *
   * @type {String}
   * @memberof Review
   */
  let lastLookup;

  /**
   * Most recently selected adapter.
   *
   * @type {Object}
   * @memberof Review
   */
  let lastAdapter;

  // Our form's behavior depends significantly on whether we're creating
  // a new review, or editing an old one.
  let editing = config.editing;
  let textFields = editing ? '#review-title,#review-text' :
    '#review-url,#review-title,#review-text';

  /**
   * Holds instance of external library for client-side storage of new reviews
   * in progress.
   *
   * @memberof Review
   */
  let sisyphus;

  // Add inputs used only with JS here so they don't appear/conflict when JS is disabled
  $('#star-rating-control').append(`<input id="review-rating" name="review-rating" type="hidden" data-required>`);

  /**
   * Rating value of previous POST request, if any.
   *
   * @memberof Review
   */
  let postRating = $('#star-rating-control').attr('data-post') || '';

  // Register event handlers

  $('[id^=star-button-]')
    .mouseout(clearStars)
    .mouseover(indicateStar)
    .click(selectStar)
    .keyup(maybeSelectStar);

  // Little "X" icon that makes previously looked up information from Wikidata
  // and other sources go away and clears out the URL field
  $('#remove-resolved-info')
    .click(removeResolvedInfo)
    .keyup(maybeRemoveResolvedInfo);

  // Highlight rating from POST request
  if (postRating)
    selectStar.apply($(`#star-button-${postRating}`)[0]);

  // We only have to worry about review subject lookup for new reviews,
  // not when editing existing reviews
  if (!editing) {
    initializeURLValidation();
    $(textFields).change(hideAbandonDraft);
    $('#review-url').keyup(function(event) {
      handleURLLookup.call(this, event, true); // Suppresses modal while typing
    });
    $('#review-url').keyup(handleURLFixes);
    $('#review-url').change(handleURLLookup);
    $('#review-url').change(handleURLValidation);
    $('#dismiss-draft-notice').click(hideDraftNotice);
    $('#abandon-draft').click(emptyAllFormFields);
    $('#add-http').click(addHTTP);
    $('#add-https').click(addHTTPS);

    // When writing a review of an existing thing, the URL field is not
    // available, so do not attempt to store data to it.
    let maybeExcludeURL = '';
    if (!$('#review-url').length)
      maybeExcludeURL = ',#review-url';

    // Persist form in local storage
    sisyphus = $('#review-form').sisyphus({
      onBeforeRestore: restoreDynamicFields,
      onRestore: processLoadedData,
      excludeFields: $('[data-ignore-autosave]' + maybeExcludeURL)
    });

    // Wire up mode switcher for source of review subject: URL or database
    $('#review-via-url').conditionalSwitcherClick(activateReviewViaURL);
    $('#review-via-database').conditionalSwitcherClick(activateReviewViaDatabase);

    // Wire up source selector dropdown for "review via database" workflow
    $('#source-selector-dropdown').change(selectSource);

    // Bubbling interferes with autocomplete's window-level click listener
    $('#source-selector-dropdown').click(function(event) {
      event.stopPropagation();
    });

    // Initialize search autocomplete for currently selected source
    selectSource.apply($('#source-selector-dropdown')[0]);
  }

  // In case we're in preview mode and have a URL, make sure we fire the URL
  // validation/lookup handlers
  if ($('#preview-contents').length && $('#review-url').val()) {
    handleURLLookup.apply($('#review-url')[0]);
    handleURLValidation.apply($('#review-url')[0]);
  }

  /**
   * Hide information indicating that an unsaved draft is available.
   *
   * @memberof Review
   */
  function hideDraftNotice() {
    if ($('#draft-notice').is(':visible'))
      $('#draft-notice').fadeOut(200);
  }

  /**
   * Remove a previously resolved review subject from a review.
   *
   * @memberof Review
   */
  function removeResolvedInfo() {
    clearResolvedInfo();
    $('#review-url').val('');
    // Trigger change-related event handlers
    handleURLLookup.apply($('#review-url')[0]);
    handleURLValidation.apply($('#review-url')[0]);
    // Update saved data w/ empty URL
    sisyphus.saveAllData();

    // Focus back on URL field.
    // We don't clear out any search fields in case the user quickly wants
    // to get back to the text they previously entered.
    $('#review-via-url').click();
  }

  /**
   * Keyboard handler that triggers {@link Review.removeResolvedInfo}
   * on `[Enter]` and `[Space]`.
   *
   * @memberof Review
   */
  function maybeRemoveResolvedInfo() {
    if (event.keyCode == 13 || event.keyCode == 32)
      removeResolvedInfo();
  }

  /**
   * Hide the option for abandoning a draft once the user has started editing
   * it.
   *
   * @memberof Review
   */
  function hideAbandonDraft() {
    if ($('#abandon-draft').is(':visible'))
      $('#abandon-draft').fadeOut(200);
  }

  /**
   * Add a HTTP or HTTPS prefix to the review URL.
   * @param {String} protocol - "http" or "https"
   *
   * @memberof Review
   */
  function addProtocol(protocol) {
    $('#review-url').val(protocol + '://' + $('#review-url').val());
    $('#review-url').trigger('change');
  }

  /**
   * Add HTTP prefix to the review URL field and focus on it.
   * @param {Event} event the click event on the "Add HTTP" link
   *
   * @memberof Review
   */
  function addHTTP(event) {
    addProtocol('http');
    $('#review-label').focus();
    event.preventDefault();
  }

  /**
   * Add HTTPS prefix to the review URL field and focus on it.
   * @param {Event} event the click event on the "Add HTTPS" link
   *
   * @memberof Review
   */
  function addHTTPS(event) {
    addProtocol('https');
    $('#review-label').focus();
    event.preventDefault();
  }

  /**
   * Ask all available adapters for information about the currently provided
   * URL, via asynchronous lookup. Note this is separate from the search
   * option -- we look up information, e.g., from Wikidata even if the user just
   * puts in a Wikidata URL.
   *
   * @param {Event} [_event]
   *  the event that triggered the lookup; not used
   * @param {Boolean} [suppressModal=false]
   *  Suppress the modal shown if the user has previously reviewed this subject.
   *  Overkill while typing, so suppressed there.
   *
   * @memberof Review
   */
  function handleURLLookup(_event, suppressModal) {
    let inputEle = this;
    let inputURL = inputEle.value;
    let promises = [];

    // Avoid duplicate lookups on keyup
    if (inputURL === lastLookup)
      return;

    // Track lookups, regardless of success or failure
    lastLookup = inputURL;

    if (!inputURL) {
      clearResolvedInfo();
      return;
    }

    // We look up this URL using all adapters that support it. The native
    // adapter performs its own URL schema validation, and other adapters
    // are more restrictive.
    adapters.forEach(adapter => {
      if (adapter.ask && adapter.lookup && adapter.ask(inputURL))
        promises.push(adapter.lookup(inputURL));
    });

    // We use a mapped array so we can catch failing promises and pass along
    // the error as payload, instead of aborting the whole process if even
    // one of the queries fails.
    Promise
      .all(promises.map(promise => promise.catch(error => ({ error }))))
      .then(results => {
        // If the URL field has been cleared since the user started the query,
        // don't bother with the result of the lookup
        if (!inputEle.value)
          return;
        // Use first valid result in order of the array. Since the native lookup
        // is the first array element, it will take precedence over any adapters.
        for (let result of results) {
          if (result.data && result.data.label) {

            // User has previously reviewed this subject
            if (result.data.thing && typeof result.data.thing.reviews == 'object' &&
              result.data.thing.reviews.length) {
              if (!suppressModal) {
                showModalForEditingExistingReview(result.data);
                return;
              } else {
                // Don't show modal - perhaps user is still typing.
                // May have to show modal later, so don't cache lookup
                lastLookup = undefined;
              }
            }
            updateReviewSubject({
              url: inputURL,
              label: result.data.label,
              description: result.data.description, // may be undefined
              subtitle: result.data.subtitle,
              thing: result.data.thing // may be undefined
            });
            return;
          }
          clearResolvedInfo();
        }
      });
  }

  /**
   * Show modal that asks the user to edit an existing review of the given
   * subject, or to pick another review subject.
   *
   * @param {Object} data
   *  data used for the redirect
   * @param {Object[]} data.reviews
   *  array of reviews by the current user for this thing. Under normal
   *  circumstances there should only be 1, but this is not a hard constraint
   *  at the database level.
   */
  function showModalForEditingExistingReview(data) {
    const $modal = $(`<div class="hidden-regular" id="review-modal"></div>`)
      .append('<p>' + msg('previously reviewed') + '</p>')
      .append('<p><b>' + data.label + '</b></p>')
      .append('<p>' + msg('abandon form changes') + '</p>')
      .append('<button class="pure-button pure-button-primary button-rounded" id="edit-existing-review">' +
        msg('edit review') + '</button>')
      .append('&nbsp;<a href="#" id="pick-different-subject">' + msg('pick a different subject') + '</a>');
    $modal.insertAfter('#review-subject');
    $modal.modal({
      escapeClose: false,
      clickClose: false,
      showClose: false
    });
    $('#edit-existing-review').click(() => {
      // Clear draft
      sisyphus.manuallyReleaseData();
      window.location.assign(`/review/${data.thing.reviews[0].id}/edit`);
    });
    $('#pick-different-subject').click(event => {
      $.modal.close();
      $modal.remove();
      $('#review-url').val('');
      $('#review-url').trigger('change');
      event.preventDefault();
    });
    $modal.lockTab();
  }

  /**
   * Clean out any old URL metadata and show the label field again
   *
   * @memberof Review
   */
  function clearResolvedInfo() {
    $('.resolved-info').empty();
    $('#review-subject').hide();
    $('.review-label-group').show();
    repaintFocusedHelp();
  }

  /**
   * Show warning and helper links as appropriate for a given subject URL.
   *
   * @memberof Review
   */
  function handleURLValidation() {
    let inputURL = this.value;

    if (inputURL && !validateURL(inputURL)) {
      $('#review-url-error').show();
      if (!urlHasSupportedProtocol(inputURL)) {
        $('.helper-links').show();
        $('#add-https').focus();
      } else {
        $('.helper-links').hide();
      }
    } else {
      $('#review-url-error').hide();
      $('.helper-links').hide();
    }
  }


  /**
   * Update UI based on URL corrections of validation problems. This is
   * registered on keyup for the URL input field, so corrections are instantly
   * detected.
   *
   * @memberof Review
   */
  function handleURLFixes() {
    let inputURL = this.value;
    if ($('#review-url-error').is(':visible')) {
      if (validateURL(inputURL)) {
        $('#review-url-error').hide();
        $('.helper-links').hide();
      }
    }
  }

  /**
   * Callback called from adapters for adding informationed obtained via an
   * adapter to the form. Except for the URL, the information is not actually
   * associated with the review, since the corresponding server-side adapter
   * will perform its own deep lookup.
   *
   * @param {Object} data - Data obtained by the adapter
   * @memberof Review
   */
  function updateURLAndReviewSubject(data) {
    if (!data.url)
      throw new Error('To update a URL, we must get one.');
    $('#review-url').val(data.url);

    // Re-validate URL. There shouldn't be any problems with the new URL, so
    // this will mainly clear out old validation errors.
    handleURLValidation.apply($('#review-url')[0]);

    // If user has previously reviewed this, they need to choose to pick a
    // different subject or to edit their existing review
    if (data.thing && data.thing.reviews) {
      // Previous adapter may have loaded info
      clearResolvedInfo();
      showModalForEditingExistingReview(data);
      return;
    }

    updateReviewSubject(data);
    // Make sure we save draft in case user aborts here
    sisyphus.saveAllData();
  }

  /**
   * Handle the non-URL information obtained via the
   * {@link Review.updateURLAndReviewSubject} callback, or via the
   * {@link Review.handleURLLookup} handler on the URL input field.
   *
   * @param {Object} data - Data obtained by the adapter
   * @memberof Review
   */
  function updateReviewSubject(data) {
    const { url, label, description, subtitle, thing } = data;
    if (!label)
      throw new Error('Review subject must have a label.');
    let wasFocused = $('#resolved-url a').is(':focus');
    $('.resolved-info').empty();
    $('#resolved-url').append(`<a href="${url}" target="_blank">${label}</a>`);
    if (description)
      $('#resolved-description').html(description);
    if (subtitle)
      $('#resolved-subtitle').html(`<i>${subtitle}</i>`);

    if (thing) {
      $('#resolved-thing').append(`<a href="/${thing.urlID}" target="_blank">${msg('more info')}</a>`);
    }
    $('#review-subject').show();
    if (wasFocused)
      $('#resolved-url a').focus();
    $('.review-label-group').hide();
    // We don't want to submit previously entered label data
    $('#review-label').val('');
    // If now hidden field is focused, focus on title field instead (next in form)
    if ($('#review-label').is(':focus') || document.activeElement === document.body)
      $('#review-title').focus();
  }


  /**
   * Clear out old draft
   *
   * @param {Event} event - click event from the "Clear draft" button
   * @memberof Review
   */
  function emptyAllFormFields(event) {
    clearStars();
    $('#review-url,#review-title,#review-text,#review-rating').val('');
    $('#review-url').trigger('change');
    for (let rte in libreviews.activeRTEs)
      libreviews.activeRTEs[rte].reRender();
    sisyphus.manuallyReleaseData();
    hideDraftNotice();
    event.preventDefault();
  }


  /**
   * Restore fields that were dynamically added by JavaScript and not part of
   * the original form.
   *
   * @memberof Review
   */
  function restoreDynamicFields() {
    const uploadRegex = /^\[id=review-form\].*\[name=(uploaded-file-.*?)\]$/;
    for (let key in localStorage) {
      if (uploadRegex.test(key)) {
        const fieldName = key.match(uploadRegex)[1];
        $('#review-form').append(`<input type="hidden" name="${fieldName}">`);
      }
    }
  }

  /**
   * Load draft data into the review form.
   *
   * @memberof Review
   */
  function processLoadedData() {
    let rating = Number($('#review-rating').val());

    // Trim just in case whitespace got persisted
    $('input[data-auto-trim],textarea[data-auto-trim]').each(trimInput);

    // Only show notice if we've actually recovered some data
    if (rating || $('#review-url').val() || $('#review-title').val() || $('#review-text').val()) {
      if (rating)
        selectStar.apply($(`#star-button-${rating}`)[0]);

      $('#draft-notice').show();
      // Repaint help in case it got pushed down
      repaintFocusedHelp();
    }

    // Show URL issues if appropriate
    if ($('#review-url').length) {
      handleURLLookup.apply($('#review-url')[0]);
      handleURLValidation.apply($('#review-url')[0]);
    }
  }


  /**
   * Replace star images with their placeholder versions
   *
   * @param {Number} start - rating from which to start clearing
   * @memberof Review
   */
  function clearStars(start) {

    if (!start || typeof start !== "number")
      start = 1;
    for (let i = start; i < 6; i++)
      replaceStar(i, `/static/img/star-placeholder.svg`, 'star-holder');
  }


  /**
   * replaceStar - Helper function to replace individual star image
   *
   * @param {Number} id - number of the star to replace
   * @param {String} src - value for image source attribute
   * @param {String} className - CSS class to assign to element
   * @memberof Review
   */
  function replaceStar(id, src, className) {
    $(`#star-button-${id}`)
      .attr('src', src)
      .removeClass()
      .addClass(className);
  }


  /**
   * Handler to restore star rating to a previously selected setting.
   *
   * @memberof Review
   */
  function restoreSelected() {
    let selectedStar = $('#star-rating-control').attr('data-selected');
    if (selectedStar)
      selectStar.apply($(`#star-button-${selectedStar}`)[0]);
  }

  /**
   * Handler to "preview" a star rating, used on mouseover.
   *
   * @returns {Number} - the number value of the selected star
   * @memberof Review
   */
  function indicateStar() {
    // We want to set all stars to the color of the selected star
    let selectedStar = Number(this.id.match(/\d/)[0]);
    for (let i = 1; i <= selectedStar; i++)
      replaceStar(i, `/static/img/star-${selectedStar}-full.svg`, 'star-full');
    if (selectedStar < 5)
      clearStars(selectedStar + 1);
    return selectedStar;
  }


  /**
   * Key handler for selecting stars with `[Enter]` or `[Space]`.
   *
   * @param  {Event} event - the key event
   */
  function maybeSelectStar(event) {
    if (event.keyCode == 13 || event.keyCode == 32)
      selectStar.apply(this);
  }

  /**
   * Actually apply a star rating.
   *
   * @memberof Review
   */
  function selectStar() {
    let selectedStar = indicateStar.apply(this);
    $('#star-rating-control').attr('data-selected', selectedStar);
    $('#star-rating-control img[id^=star-button-]')
      .off('mouseout')
      .mouseout(restoreSelected);
    $('#review-rating').val(selectedStar);
    $('#review-rating').trigger('change');
  }


  /**
   * Add template for URL validation errors, including "Add HTTP" and "Add HTTPS"
   * helper links.
   *
   * @memberof Review
   */
  function initializeURLValidation() {
    $('#url-validation').append(
      `<div id="review-url-error" class="validation-error">${msg('not a url')}</div>` +
      `<div class="helper-links"><a href="#" id="add-https">${msg('add https')}</a> &ndash; <a href="#" id="add-http">${msg('add http')}</a></div>`
    );
  }

  /**
   * Click handler for activating the form for reviewing a subject by specifying
   * a URL
   *
   * @memberof Review
   */
  function activateReviewViaURL() {
    $('#review-via-database-inputs').addClass('hidden');
    $('#review-via-url-inputs').removeClass('hidden');
    $('.review-label-group').removeClass('hidden-regular');
    $('#source-selector').toggleClass('hidden', true);
    if (!$('#review-url').val())
      $('#review-url').focus();
  }


  /**
   * Click handler for activating the form for reviewing a subject by selecting
   * it from an external database.
   *
   * @param  {Event} event - the click event
   * @memberof Review
   */
  function activateReviewViaDatabase(event) {
    // Does not conflict with other hide/show actions on this group
    $('.review-label-group').addClass('hidden-regular');
    $('#review-via-url-inputs').addClass('hidden');
    $('#review-via-database-inputs').removeClass('hidden');
    // Focusing pops the selection back up, so this check is extra important here
    $('#source-selector').toggleClass('hidden', false);
    if (!$('#review-search-database').val()) {
      $('#review-search-database').focus();
      // Ensure focus event to mount autocomplete widget is triggered
      const focusEvent = new FocusEvent('focus', {
        view: window,
        bubbles: false,
        cancelable: true
      });
      $('#review-search-database')[0].dispatchEvent(focusEvent);
    }
    // Suppress event bubbling up to window, which the AC widget listens to, and
    // which would unmount the autocomplete function
    event.stopPropagation();
  }


  /**
   * Handler for selecting a source from the "database sources" dropdown,
   * which requires lookup using an adapter plugin.
   *
   * @memberof Review
   */
  function selectSource() {
    let sourceID = $(this).val();

    let adapter;
    // Locate adapter responsible for source declared in dropdown
    for (let a of adapters) {
      if (a.getSourceID() == sourceID) {
        adapter = a;
        break;
      }
    }

    if (lastAdapter && lastAdapter.removeAutocomplete)
      lastAdapter.removeAutocomplete();

    if (adapter && adapter.setupAutocomplete) {
      adapter.setupAutocomplete();
      if (lastAdapter) {
        // Re-run search, unless this is the first one. Sets focus on input.
        if (adapter.runAutocomplete)
          adapter.runAutocomplete();

        // Change help text
        $('#review-search-database-help .help-heading')
          .html(msg(`review via ${adapter.getSourceID()} help label`));

        $('#review-search-database-help .help-paragraph')
          .html(msg(`review via ${adapter.getSourceID()} help text`));

        // Change input placeholder
        $('#review-search-database').attr('placeholder',
          msg(`start typing to search ${adapter.getSourceID()}`));

        repaintFocusedHelp();
      }
    }

    // Track usage of the adapter so we can run functions on change
    lastAdapter = adapter;
  }

}());
