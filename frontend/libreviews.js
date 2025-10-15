/* global $, jQuery, AC, config */
/* eslint prefer-reflect: "off" */

/*
 * Standard helper functions across lib.reviews pages, divided into jQuery
 * plugins and more lib.reviews-specific functionality.
 * @license CC-0; see https://creativecommons.org/publicdomain/zero/1.0/
 */

(function($) {
  'use strict';

  // Return any empty input elements among a selector of inputs
  $.fn.getEmptyInputs = function() {
    return this.filter(function() {
      return this.value === undefined || String(this.value) === '';
    });
  };

  // Highlight labels associated with a set of elements using an indicator
  // class. Typically used to highlight required form fields, in combination
  // with emptyInputs(). This will not hide previously set labels.
  $.fn.highlightLabels = function(indicatorSelector) {

    if (!indicatorSelector)
      indicatorSelector = "span.required";

    // Show the ones from our current jQuery object
    this.each(function() {
      $(`label[for="${this.id}"] ${indicatorSelector}`).show();
    });

    // Return the (unmodified) object for further processing/chaining as needed
    return this;
  };

  $.fn.attachRequiredFieldHandler = function(options) {

    if (!options)
      options = {};

    // How we find "* required" indicators that are child elements of labels
    let indicatorSelector = options.indicatorSelector || 'span.required';

    // Error message(s) selector informing user required fields are missing
    let requiredFieldsMessage = options.requiredFieldMessage || '#required-fields-message';

    // Error message(s) selector reminding user about other validation errors
    let formErrorMessage = options.formErrorMessage || '#form-error-message';

    let formSelector = options.formSelector ? options.formSelector + ' ' : '';

    // Selector used to find any remaining validation errors that need to be corrected
    let validationErrorSelector = options.validationErrorSelector ||
      `${formSelector}.validation-error:visible`;

    // Callback to call in case no form issues are present
    let cb = options.callback;

    this.click(requiredFieldHandler);

    function requiredFieldHandler(event) {

      // Clear out old warnings
      $(`${formSelector}${requiredFieldsMessage},${formSelector}${formErrorMessage},${formSelector}label ${indicatorSelector}`).hide();

      let $emptyFields = $(`${formSelector}input[data-required],${formSelector}textarea[data-required],${formSelector}select[data-required]`)
        .getEmptyInputs()
        .highlightLabels();

      if ($emptyFields.length) {
        $(requiredFieldsMessage).show();
        event.preventDefault();
        return;
      }

      // Highlight any other validation errors now (not doing it earlier to avoid
      // error message overkill)
      if ($(validationErrorSelector).length > 0) {
        $(formErrorMessage).show();
        event.preventDefault();
        return;
      }

      if (cb)
        cb.call(this, event);

    }

  };

  /**
   * Prevent tabbing outside a given container; useful for modals.
   * Credit: Alexander Puchkov
   * https://stackoverflow.com/posts/21811463/revisions
   *
   * @param {jQuery} $element
   *  Container element, e.g., a dialog
   */
  $.fn.lockTab = function() {
    const $inputs = this
      .find('select, input, textarea, button, a, [data-focusable]')
      .filter(':visible');
    const $firstInput = $inputs.first();
    const $lastInput = $inputs.last();

    // set focus on first input
    $firstInput.focus();

    // redirect last tab to first input
    $lastInput.on('keydown', function(e) {
      if (e.which === 9 && !e.shiftKey) {
        e.preventDefault();
        $firstInput.focus();
      }
    });

    // redirect first shift+tab to last input
    $firstInput.on('keydown', function(e) {
      if (e.which === 9 && e.shiftKey) {
        e.preventDefault();
        $lastInput.focus();
      }
    });
  };

  // Toggle a two-state switcher control defined like so (simplified, see
  // review-form.hbs for an example):
  //
  // <div class="switcher-control">
  // <span class="switcher-option switcher-option-selected"
  // data-action="some-descriptive-string">Option label</span>
  // ...
  // </div>
  //
  // While it only supports two states for now, it shouldn't be too hard to
  // extend it down the line.
  //
  // Use the click handler below for business logic attached to each switcher
  // option.
  $.fn.toggleSwitcher = function() {

    // Checkmark to highlight currently selected option
    let $selectedIndicator = $('<span class="fa fa-fw fa-check-circle switcher-selected-indicator">&nbsp;</span>');

    let $from = this.find('.switcher-option.switcher-option-selected'),
      $to = this.find('.switcher-option').not('.switcher-option-selected');

    $from
      .removeClass('switcher-option-selected')
      .addClass('switcher-option-selectable')
      .find('.switcher-selected-indicator')
      .remove();

    $to
      .removeClass('switcher-option-selectable')
      .addClass('switcher-option-selected')
      .prepend($selectedIndicator);

  };

  // Toggle the switcher and call an event handler if the user clicked on
  // a selectable option
  $.fn.conditionalSwitcherClick = function(eventHandler) {

    this.click(function(event) {
      if ($(this).hasClass('switcher-option-selected'))
        return false;
      $(this).parent().toggleSwitcher();
      eventHandler.call(this, event);
    });

  };

}(jQuery));

(function() {
  'use strict';
  // Global namespace for lib.reviews-specific functions
  window.libreviews = {};

  // Simple helper function, should be replaced w/ proper client-side i18n
  // down the road.
  //
  // The first parameter is always a message key. Optionally, pass an object
  // as the second parameter, like so:
  //
  // {
  //   stringParam: 'text'
  //   accessKey: 'b',
  // }
  //
  // accessKey above will add a second line of text hinting the "b" access key.
  //
  // stringParam above will replace a single instance of %s with the value text.
  // You can also include an array, stringParams, for substitutions of
  // the type %1$s, %2$s
  //
  // numberParam / numberParams has the same effect for %d, %1$d
  //
  // If the message key cannot be found, the string '?<key>?' will be returned.
  window.libreviews.msg = function(messageKey, options) {

    if (!window.config || !window.config.messages || !window.config.messages[messageKey])
      return `?${messageKey}?`;

    let rv = window.config.messages[messageKey];

    // Just a simple lookup? Okay!
    if (typeof options !== 'object')
      return rv;

    // Destructure options
    const { accessKey, stringParam, stringParams, numberParam, numberParams } = options;

    // We're partially reinventing sprintf here, switch to module if we want
    // to add any more.
    if (stringParam !== undefined)
      rv = processSingleParam(rv, 's', String(stringParam));

    if (Array.isArray(stringParams))
      rv = processOrderedParams(rv, 's', stringParams);

    if (numberParam !== undefined)
      rv = processSingleParam(rv, 'd', Number(numberParam));

    if (Array.isArray(numberParams))
      rv = processOrderedParams(rv, 'd', numberParams);

    if (accessKey && window.config.messages['accesskey'])
      rv += '\n' + window.config.messages['accesskey'].replace('%s', accessKey);

    return rv;

    function processSingleParam(str, typeStr, param) {
      return str.replace(`%${typeStr}`, param);
    }

    function processOrderedParams(str, typeStr, paramArr) {
      paramArr.forEach((orderedParam, index) => {
        index++; // Array starts at 0
        str = str.replace(new RegExp(`%${index}\\$${typeStr}`, 'g'), orderedParam);
      });
      return str;
    }
  };

  // A simplified resolver for multilingual string. Tries chosen language
  // & falls back on English, then first available. Returns string
  // or undefined
  window.libreviews.resolveString = function(lang, strObj) {
    if (strObj === undefined)
      return undefined;

    // Direct language match
    if (typeof strObj[lang] === 'string' && strObj[lang] !== '')
      return strObj[lang];

    // Fall back to non-empty key
    for (let k in strObj) {
      if (typeof strObj[k] === 'string' && strObj[k] !== '')
        return strObj[k];
    }

    return undefined;

  };

  // Render a language identifier in the same style as the server-side helper.
  // Returns jQuery object.
  window.libreviews.getLanguageIDSpan = function(lang) {
    if (typeof lang !== 'string')
      throw new Error('Need valid language identifier.');

    let title = window.libreviews.msg(`language ${lang} composite name`);
    return $(`<span class="language-identifier" title="${title}">`)
      .text(lang.toUpperCase())
      .prepend('<span class="fa fa-fw fa-globe language-identifier-icon">&nbsp;</span>');
  };


  window.libreviews.trimInput = function() {
    this.value = this.value.trim();
  };

  // For groups of form controls that are sometimes, but not always, required
  // inputs, we can enable the required check selectively. To do so, we need
  // to set the "data-required-indicator-group" and "data-required-input-group"
  // to a unique ID for each group, and set the data-enable-required-group
  // and data-disable-required-group to the same ID for the controls which
  // change the state (for now only radio controls are supported).
  // The indicator also needs to have the "hidden" class initially.
  window.libreviews.enableRequiredGroup = function(groupID) {
    $(`span[data-required-indicator-group="${groupID}"]`)
      .addClass('required')
      .removeClass('hidden');
    $(`[data-required-input-group="${groupID}"]`)
      .attr('data-required', '');
  };

  window.libreviews.disableRequiredGroup = function(groupID) {
    $(`span[data-required-indicator-group="${groupID}"]`)
      .addClass('hidden')
      .removeClass('required');
    $(`[data-required-input-group="${groupID}"]`)
      .removeAttr('data-required');
  };

  $('input[type="radio"][data-enable-required-group]').focus(function() {
    window.libreviews.enableRequiredGroup($(this).attr('data-enable-required-group'));
  });

  $('input[type="radio"][data-disable-required-group]').focus(function() {
    window.libreviews.disableRequiredGroup($(this).attr('data-disable-required-group'));
  });


  // Generic function for dismiss buttons. The attribute data-dismiss-element
  // must specify an element ID.
  $('button[data-dismiss-element]').click(function(event) {
    let id = $(this).attr('data-dismiss-element');
    $(`#${id}`).fadeOut(200);
    event.preventDefault();
  });

  // Generic function to permanently dismiss notices of a certain kind.
  // This is useful for introductory messages, or community-wide banners.
  $('button[data-suppress-notice]').click(function(event) {
    let id = $(this).attr('data-suppress-notice');
    $.ajax({
        type: 'POST',
        url: `/api/actions/suppress-notice`,
        data: JSON.stringify({
          noticeType: id
        }),
        contentType: 'application/json',
        dataType: 'json'
      })
      .done(() => {
        $(`#${id}`).fadeOut(200);
      })
      .fail(() => {
        $('#generic-action-error').removeClass('hidden');
      });
    event.preventDefault();
  });

  // Prevents submission of buttons that have data-check-required when required
  // fields are missing
  $('button[data-check-required]').attachRequiredFieldHandler();

  // Auto-trim all inputs with data-auto-trim
  $('input[data-auto-trim],textarea[data-auto-trim]').change(window.libreviews.trimInput);

  // Add link anchors to long texts
  $('.long-text h2,.long-text h3').each(function() {
    $(this).prepend(`<a href="#${this.id}" class="fragment-link no-print"><span class="fa fa-link"></span></a>`);
  });

  // For toggling visibility of long texts. Looks a bit nicer and is more
  // hackable than the "spoiler warning" controls but only works with JS.
  // Example use:
  //
  // <div class="expand-container nojs-hidden">
  // <span class="expand-link" tabindex="0" data-target="some-target-container"
  // data-toggle-text="Collapse it!"><span class="expand-label">Show it!</span>
  // <span class="fa fa-chevron-down expand-icon"></span>
  // </span>
  // </div>
  $('.expand-link').click(function() {
    let target = $(this).attr('data-target');
    if (target) {
      let toggleText = $(this).attr('data-toggle-text');
      let $target = $(`#${target}`);
      $(this).find('.expand-icon').toggleClass('fa-chevron-down');
      $(this).find('.expand-icon').toggleClass('fa-chevron-up');
      $target.slideToggle(200, () => {
        if (toggleText) {
          let oldToggleText = $(this).find('.expand-label').text();
          $(this).find('.expand-label').text(toggleText);
          $(this).attr('data-toggle-text', oldToggleText);
        }
      });
    }
  });

  // Also toggle if users presses enter key
  $('.expand-link').keyup(function(e) {
    if (e.which == 13)
      $('.expand-link').trigger('click');
  });

  // Dynamic help sidebars

  // Exported repaint function, trigger this if you need to repaint the
  // help because of a change in scroll position. This is done automatically
  // for window resizes.
  window.libreviews.repaintFocusedHelp = () => {
    let $focused = $(':focus');
    if (!$focused.length)
      return;

    let id = $focused.attr('data-acts-as') || $focused[0].id;
    // Check if the currently focused element requires a help re-render
    if (id && $(`[data-help-for=${id}]`).length)
      showInputHelp.apply($focused[0]);
  };

  // Add listeners for dynamic help to a given input element
  window.libreviews.addHelpListeners = function($input) {
    $input.focus(showInputHelp);
    $input.blur(hideInputHelp);
    // Re-calculate positioning of help in case of resizes
    if (typeof MutationObserver !== 'undefined') {
      new MutationObserver(window.libreviews.repaintFocusedHelp).observe($input[0], {
        attributes: true,
        attributeFilter: ['style']
      });
    }
  };

  // Now do this for all the relevant inputs we can currently locate on the page
  if ($('[data-help-for]').length) {

    // Attach dynamic help display for data-help-for="id" elements (to the "id"
    // element, typically an input)
    $('[data-help-for]').each(function() {
      let inputID = $(this).attr('data-help-for');
      let $input = $(`#${inputID}`);
      window.libreviews.addHelpListeners($input);
    });

    // Re-calculate positioning of help on window resize
    $(window).resize(window.libreviews.repaintFocusedHelp);

  }

  // Show/hide parts of a page dynamically
  $('[data-show]').focus(function() {
    $(`#${$(this).attr('data-show')}`).slideDown(200);
  });

  $('[data-hide]').focus(function() {
    $(`#${$(this).attr('data-hide')}`).slideUp(200);
  });

  // Focus input
  $('[data-focus]').focus();

  // Activate tooltips
  $('[data-powertip]')
    .attr('title', '') // Clear title attribute, which would overlap
    .powerTip({
      placement: "s", // Try to place below the element
      smartPlacement: true, // If that doesn't work, pick best placement
      mouseOnToPopup: true // Allow user to interact with links inside the tooltip
    });

  // Buttons that copy text into the clipboard
  $('[data-copy]').click(function() {
    let copySourceID = $(this).attr('data-copy');
    let copySource = $(`#${copySourceID}`)[0];

    let range = document.createRange();
    range.selectNode(copySource);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);
    try {
      document.execCommand('copy');
    } catch (error) {
      console.error('Copying not supported in your browser.');
    }
  });

  // Some click handlers exist inside content which may be dynamically generated.
  window.libreviews.updateContentClickHandlers = () => {
    $('summary.content-warning-notice').click(toggleDangerousContent);
  };

  window.libreviews.updateContentClickHandlers();

  window.libreviews.validateURL = function(url) {
    const urlRegex = /^(https?|ftp):\/\/(((([a-z]|\d|-|\.|_|~|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])|(%[\da-f]{2})|[!$&'()*+,;=]|:)*@)?(((\d|[1-9]\d|1\d\d|2[0-4]\d|25[0-5])\.(\d|[1-9]\d|1\d\d|2[0-4]\d|25[0-5])\.(\d|[1-9]\d|1\d\d|2[0-4]\d|25[0-5])\.(\d|[1-9]\d|1\d\d|2[0-4]\d|25[0-5]))|((([a-z]|\d|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])|(([a-z]|\d|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])([a-z]|\d|-|\.|_|~|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])*([a-z]|\d|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])))\.)+(([a-z]|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])|(([a-z]|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])([a-z]|\d|-|\.|_|~|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])*([a-z]|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])))\.?)(:\d*)?)(\/((([a-z]|\d|-|\.|_|~|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])|(%[\da-f]{2})|[!$&'()*+,;=]|:|@)+(\/(([a-z]|\d|-|\.|_|~|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])|(%[\da-f]{2})|[!$&'()*+,;=]|:|@)*)*)?)?(\?((([a-z]|\d|-|\.|_|~|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])|(%[\da-f]{2})|[!$&'()*+,;=]|:|@)|[\uE000-\uF8FF]|\/|\?)*)?(#((([a-z]|\d|-|\.|_|~|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])|(%[\da-f]{2})|[!$&'()*+,;=]|:|@)|\/|\?)*)*$/i;
    return urlRegex.test(url);
  };

  window.libreviews.urlHasSupportedProtocol = function(url) {
    let protocolRegex = /^(https?|ftp):\/\//;
    return protocolRegex.test(url);
  };

  // Add autocompletion to search box if present
  if ($('#search-input').length)
    setupSearch();

  // For content which is hidden by default and can be expanded, e.g., spoiler
  // warnings, NSFW warnings
  function toggleDangerousContent(event) {
    if ($(this).parent().is('[open]')) {
      $(this).next('.dangerous-content').slideUp(200, () => {
        $(this).parent().removeAttr('open');
      });
    } else {
      $(this).parent().attr('open', '');
      $(this).next('.dangerous-content').slideDown(200);
    }
    event.preventDefault();
  }

  function setupSearch() {
    let ac = new AC($('#search-input')[0], null, requestFn, null, rowFn, triggerFn);
    ac.delay = 0;

    function triggerFn(row) {
      if (row.urlID)
        window.location = `/${row.urlID}`;
    }

    function rowFn(row) {
      // Row-level CSS gets added by library
      let $el = $('<div>');

      let $primary = $('<span>')
        .addClass(this.getCSS('PRIMARY_SPAN'))
        .append($(AC.createMatchTextEls(this.value,
          row[this.primaryTextKey])))
        .appendTo($el);

      if (row.language)
        $primary
        .append(window.libreviews.getLanguageIDSpan(row.language)
          .addClass('language-identifier-search-row'));

      if (row.description) {
        $('<span>')
          .addClass(this.getCSS('SECONDARY_SPAN'))
          .text(row.description)
          .appendTo($el);
      }
      return $el[0];
    }

    function requestFn(query) {
      const time = Date.now();

      // Keep track of most recently fired query so we can ignore responses
      // coming in late
      if (this.latestQuery === undefined || this.latestQuery < time)
        this.latestQuery = time;

      this.results = [];
      query = query.trim();
      if (query) {
        $
          .get(`/api/suggest/thing/${encodeURIComponent(query)}`)
          .done(res => {
            // Don't update if a more recent query has superseded this one
            if (time < this.latestQuery)
              return;

            this.results = [];
            if (res.results) {

              // We don't want to show any suggestion more than once, even
              // if it appears in multiple languages
              let seenIDs = [];

              // Helper function for adding labels to the suggestions array
              let processLabelKey = (labelKey, labelLanguage) => {
                for (let label of res.results[labelKey]) {
                  // Don't include any result more than once
                  if (seenIDs.indexOf(label._id) !== -1)
                    continue;
                  seenIDs.push(label._id);

                  let suggestion = {
                    title: label.text,
                    urlID: label.urlID,
                    description: window.libreviews.resolveString(config.language, label.description)
                  };
                  if (labelLanguage !== config.language)
                    suggestion.language = labelLanguage;

                  this.results.push(suggestion);
                }
                Reflect.deleteProperty(res.results, labelKey);
              };

              // Process the user's currently selected language before others
              let myLabelKey = `labels-${config.language}`;
              if (Array.isArray(res.results[myLabelKey]) && res.results[myLabelKey].length)
                processLabelKey(myLabelKey, config.language);

              // Process remaining languages
              for (let labelKey in res.results) {
                let labelLanguage = (labelKey.match(/labels-(.*)/) || [])[1];
                if (!labelLanguage)
                  continue;
                processLabelKey(labelKey, labelLanguage);
              }
            }
            this.render();
          });
      } else {
        this.render();
      }
    }
  }

  // Show input help for an element bound to `this`.
  function showInputHelp() {
    // data-acts-as is set for inputs that are an alternative representation
    // of a main element -- e.g., an RTE for a textarea
    let id = $(this).attr('data-acts-as') || this.id;
    // Hide all help texts
    $('.help-text').hide();

    // Show help text for active input
    $(`#${id}-help`).show();

    // We want to avoid pushing down the next form field, so we use
    // absolute positioning if available.
    if (this.getBoundingClientRect && $(`label[for=${id}]`)[0]) {
      let posHelp, posLabel;
      posLabel = $(`label[for=${id}]`)[0].getBoundingClientRect();
      posHelp = $(`#${id}-help`)[0].getBoundingClientRect();

      // Recaculate boundaries for all inputs in case fields have been resized,
      // e.g., textarea via resize triangle. We don't want any help text to
      // start before the rightmost one, so that it doesn't bleed into the
      // control below it
      let maxRight;
      $(this)
        .parents('form')
        .find('input,textarea')
        .each(function() {
          let eleRight = this.getBoundingClientRect().right;
          if (maxRight === undefined || maxRight < eleRight)
            maxRight = eleRight;
        });

      if (posHelp.left > posLabel.right && document.body.clientWidth >= Math.ceil(posLabel.width) + Math.ceil(posHelp.width) + 5) {
        // Position vertically aligned with the input we're showing help for
        let newTopPos = Math.floor(window.scrollY) + Math.floor(posLabel.top);
        let newLeftPos = maxRight + 5;
        let style = `position:absolute;top:${newTopPos}px;display:inline-block;left:${newLeftPos}px;`;
        $(`#${id}-help`).attr('style', style);
      } else {
        // Reset position below input element
        $(`#${id}-help`).attr('style', 'display:inline-block;');
      }
    }
  }

  function hideInputHelp() {
    let id = $(this).attr('data-acts-as') || this.id;
    // Keep help visible if user is hoving over it, so
    // links remain accessible
    if (!$('.help-text:hover').length)
      $(`#${id}-help`).hide();
  }

  console.log(
    '\n' +
    '    ___ __\n' +
    '   / (_) /_    ________ _   __(_)__ _      _______\n' +
    '  / / / __ \\  / ___/ _ \\ | / / / _ \\ | /| / / ___/\n' +
    ' / / / /_/ / / /  /  __/ |/ / /  __/ |/ |/ (__  )\n' +
    '/_/_/_.___(_)_/   \\___/|___/_/\\___/|__/|__/____/\n' +
    'Happy hacking! https://github.com/permacommons/lib.reviews\n\n'
  );
}());
