import $ from './lib/jquery.js';
import 'jquery-powertip';
import 'jquery-modal';
import './styles/style.less';
import Autocomplete from './lib/ac.mjs';
import initializeSisyphus from './lib/sisyphus.js';

let initialized = false;

initializeSisyphus();

function msg(messageKey, options) {
  if (!globalThis.config || !globalThis.config.messages || !globalThis.config.messages[messageKey])
    return `?${messageKey}?`;

  let rv = globalThis.config.messages[messageKey];

  if (typeof options !== 'object')
    return rv;

  const { accessKey, stringParam, stringParams, numberParam, numberParams } = options;

  if (stringParam !== undefined)
    rv = processSingleParam(rv, 's', String(stringParam));

  if (Array.isArray(stringParams))
    rv = processOrderedParams(rv, 's', stringParams);

  if (numberParam !== undefined)
    rv = processSingleParam(rv, 'd', Number(numberParam));

  if (Array.isArray(numberParams))
    rv = processOrderedParams(rv, 'd', numberParams);

  if (accessKey && globalThis.config.messages['accesskey'])
    rv += '\n' + globalThis.config.messages['accesskey'].replace('%s', accessKey);

  return rv;

  function processSingleParam(str, typeStr, param) {
    return str.replace(`%${typeStr}`, param);
  }

  function processOrderedParams(str, typeStr, paramArr) {
    paramArr.forEach((orderedParam, index) => {
      index++;
      str = str.replace(new RegExp(`%${index}\\$${typeStr}`, 'g'), orderedParam);
    });
    return str;
  }
}

function resolveString(lang, strObj) {
  if (strObj === undefined)
    return undefined;

  if (typeof strObj[lang] === 'string' && strObj[lang] !== '')
    return strObj[lang];

  for (let k in strObj) {
    if (typeof strObj[k] === 'string' && strObj[k] !== '')
      return strObj[k];
  }

  return undefined;
}

function getLanguageIDSpan(lang) {
  if (typeof lang !== 'string')
    throw new Error('Need valid language identifier.');

  let title = msg(`language ${lang} composite name`);
  return $(`<span class="language-identifier" title="${title}">`)
    .text(lang.toUpperCase())
    .prepend('<span class="fa fa-fw fa-globe language-identifier-icon">&nbsp;</span>');
}

function trimInput() {
  this.value = this.value.trim();
}

function enableRequiredGroup(groupID) {
  $(`span[data-required-indicator-group="${groupID}"]`)
    .addClass('required')
    .removeClass('hidden');
  $(`[data-required-input-group="${groupID}"]`)
    .attr('data-required', '');
}

function disableRequiredGroup(groupID) {
  $(`span[data-required-indicator-group="${groupID}"]`)
    .addClass('hidden')
    .removeClass('required');
  $(`[data-required-input-group="${groupID}"]`)
    .removeAttr('data-required');
}

const repaintFocusedHelp = () => {
  let $focused = $(':focus');
  if (!$focused.length)
    return;

  let id = $focused.attr('data-acts-as') || $focused[0].id;
  if (id && $(`[data-help-for=${id}]`).length)
    showInputHelp.apply($focused[0]);
};

function addHelpListeners($input) {
  $input.focus(showInputHelp);
  $input.blur(hideInputHelp);
  if (typeof MutationObserver !== 'undefined') {
    new MutationObserver(repaintFocusedHelp).observe($input[0], {
      attributes: true,
      attributeFilter: ['style']
    });
  }
}

const updateContentClickHandlers = () => {
  $('summary.content-warning-notice').click(toggleDangerousContent);
};

function validateURL(url) {
  const urlRegex = /^(https?|ftp):\/\/(((([a-z]|\d|-|\.|_|~|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])|(%[\da-f]{2})|[!$&'()*+,;=]|:)*@)?(((\d|[1-9]\d|1\d\d|2[0-4]\d|25[0-5])\.(\d|[1-9]\d|1\d\d|2[0-4]\d|25[0-5])\.(\d|[1-9]\d|1\d\d|2[0-4]\d|25[0-5])\.(\d|[1-9]\d|1\d\d|2[0-4]\d|25[0-5]))|((([a-z]|\d|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])|(([a-z]|\d|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])([a-z]|\d|-|\.|_|~|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])*([a-z]|\d|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])))\.)+(([a-z]|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])|(([a-z]|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])([a-z]|\d|-|\.|_|~|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])*([a-z]|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])))\.?)(:\d*)?)(\/((([a-z]|\d|-|\.|_|~|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])|(%[\da-f]{2})|[!$&'()*+,;=]|:|@)+(\/(([a-z]|\d|-|\.|_|~|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])|(%[\da-f]{2})|[!$&'()*+,;=]|:|@)*)*)?)?(\?((([a-z]|\d|-|\.|_|~|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])|(%[\da-f]{2})|[!$&'()*+,;=]|:|@)|[\uE000-\uF8FF]|\/|\?)*)?(#((([a-z]|\d|-|\.|_|~|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])|(%[\da-f]{2})|[!$&'()*+,;=]|:|@)|\/|\?)*)*$/i;
  return urlRegex.test(url);
}

function urlHasSupportedProtocol(url) {
  let protocolRegex = /^(https?|ftp):\/\//;
  return protocolRegex.test(url);
}

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
  let ac = new Autocomplete($('#search-input')[0], null, requestFn, null, rowFn, triggerFn);
  ac.delay = 0;

  function triggerFn(result, event) {
    if (!result || !result.urlID)
      return;

    if (event && typeof event.preventDefault === 'function')
      event.preventDefault();

    window.location = `/${result.urlID}`;
  }

  function rowFn(row) {
    const $row = $('<div>');

    const $primary = $('<span>')
      .addClass(this.getCSS('PRIMARY_SPAN'))
      .append($(Autocomplete.createMatchTextEls(this.value, row[this.primaryTextKey])))
      .appendTo($row);

    if (row.language)
      $primary.append(
        getLanguageIDSpan(row.language).addClass('language-identifier-search-row')
      );

    if (row.description) {
      $('<span>')
        .addClass(this.getCSS('SECONDARY_SPAN'))
        .text(row.description)
        .appendTo($row);
    }

    return $row[0];
  }

  function requestFn(query) {
    let time = Date.now();
    this.latestQuery = time;
    this.results = [];
    query = query.trim();
    if (query) {
      $
        .get(`/api/suggest/thing/${encodeURIComponent(query)}`)
        .done(res => {
          if (time < this.latestQuery)
            return;

          this.results = [];
          if (res.results) {
            let seenIDs = [];

            let processLabelKey = (labelKey, labelLanguage) => {
              for (let label of res.results[labelKey]) {
                if (seenIDs.indexOf(label._id) !== -1)
                  continue;
                seenIDs.push(label._id);

                let suggestion = {
                  title: label.text,
                  urlID: label.urlID,
                  description: resolveString(globalThis.config.language, label.description)
                };
                if (labelLanguage !== globalThis.config.language)
                  suggestion.language = labelLanguage;

                this.results.push(suggestion);
              }
              Reflect.deleteProperty(res.results, labelKey);
            };

            let myLabelKey = `labels-${globalThis.config.language}`;
            if (Array.isArray(res.results[myLabelKey]) && res.results[myLabelKey].length)
              processLabelKey(myLabelKey, globalThis.config.language);

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

function showInputHelp() {
  let id = $(this).attr('data-acts-as') || this.id;
  $('.help-text').hide();
  $(`#${id}-help`).show();

  if (this.getBoundingClientRect && $(`label[for=${id}]`)[0]) {
    let posHelp;
    let posLabel;
    posLabel = $(`label[for=${id}]`)[0].getBoundingClientRect();
    posHelp = $(`#${id}-help`)[0].getBoundingClientRect();

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
      let newTopPos = Math.floor(window.scrollY) + Math.floor(posLabel.top);
      let newLeftPos = maxRight + 5;
      let style = `position:absolute;top:${newTopPos}px;display:inline-block;left:${newLeftPos}px;`;
      $(`#${id}-help`).attr('style', style);
    } else {
      $(`#${id}-help`).attr('style', 'display:inline-block;');
    }
  }
}

function hideInputHelp() {
  let id = $(this).attr('data-acts-as') || this.id;
  if (!$('.help-text:hover').length)
    $(`#${id}-help`).hide();
}

function initializePlugins() {
  $.fn.getEmptyInputs = function() {
    return this.filter(function() {
      return this.value === undefined || String(this.value) === '';
    });
  };

  $.fn.highlightLabels = function(indicatorSelector) {
    if (!indicatorSelector)
      indicatorSelector = 'span.required';

    this.each(function() {
      $(`label[for="${this.id}"] ${indicatorSelector}`).show();
    });

    return this;
  };

  $.fn.attachRequiredFieldHandler = function(options) {
    if (!options)
      options = {};

    let indicatorSelector = options.indicatorSelector || 'span.required';
    let requiredFieldsMessage = options.requiredFieldMessage || '#required-fields-message';
    let formErrorMessage = options.formErrorMessage || '#form-error-message';
    let formSelector = options.formSelector ? options.formSelector + ' ' : '';
    let validationErrorSelector = options.validationErrorSelector ||
      `${formSelector}.validation-error:visible`;
    let cb = options.callback;

    this.click(requiredFieldHandler);

    function requiredFieldHandler(event) {
      $(`${formSelector}${requiredFieldsMessage},${formSelector}${formErrorMessage},${formSelector}label ${indicatorSelector}`).hide();

      let $emptyFields = $(`${formSelector}input[data-required],${formSelector}textarea[data-required],${formSelector}select[data-required]`)
        .getEmptyInputs()
        .highlightLabels();

      if ($emptyFields.length) {
        $(requiredFieldsMessage).show();
        event.preventDefault();
        return;
      }

      if ($(validationErrorSelector).length > 0) {
        $(formErrorMessage).show();
        event.preventDefault();
        return;
      }

      if (cb)
        cb.call(this, event);
    }
  };

  $.fn.lockTab = function() {
    const $inputs = this
      .find('select, input, textarea, button, a, [data-focusable]')
      .filter(':visible');
    const $firstInput = $inputs.first();
    const $lastInput = $inputs.last();

    $firstInput.focus();

    $lastInput.on('keydown', function(e) {
      if (e.which === 9 && !e.shiftKey) {
        e.preventDefault();
        $firstInput.focus();
      }
    });

    $firstInput.on('keydown', function(e) {
      if (e.which === 9 && e.shiftKey) {
        e.preventDefault();
        $lastInput.focus();
      }
    });
  };

  $.fn.toggleSwitcher = function() {
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

  $.fn.conditionalSwitcherClick = function(eventHandler) {
    this.click(function(event) {
      if ($(this).hasClass('switcher-option-selected'))
        return false;
      $(this).parent().toggleSwitcher();
      eventHandler.call(this, event);
    });
  };
}

function initializeLibreviews() {
  if (initialized)
    return libreviews;

  initializePlugins();
  initializeSisyphus();

  $('input[type="radio"][data-enable-required-group]').focus(function() {
    enableRequiredGroup($(this).attr('data-enable-required-group'));
  });

  $('input[type="radio"][data-disable-required-group]').focus(function() {
    disableRequiredGroup($(this).attr('data-disable-required-group'));
  });

  $('button[data-dismiss-element]').click(function(event) {
    let id = $(this).attr('data-dismiss-element');
    $(`#${id}`).fadeOut(200);
    event.preventDefault();
  });

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

  $('button[data-check-required]').attachRequiredFieldHandler();

  $('input[data-auto-trim],textarea[data-auto-trim]').change(trimInput);

  $('.long-text h2,.long-text h3').each(function() {
    $(this).prepend(`<a href="#${this.id}" class="fragment-link no-print"><span class="fa fa-link"></span></a>`);
  });

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

  $('.expand-link').keyup(function(e) {
    if (e.which == 13)
      $('.expand-link').trigger('click');
  });

  if ($('[data-help-for]').length) {
    $('[data-help-for]').each(function() {
      let inputID = $(this).attr('data-help-for');
      let $input = $(`#${inputID}`);
      addHelpListeners($input);
    });

    $(window).resize(repaintFocusedHelp);
  }

  $('[data-show]').focus(function() {
    $(`#${$(this).attr('data-show')}`).slideDown(200);
  });

  $('[data-hide]').focus(function() {
    $(`#${$(this).attr('data-hide')}`).slideUp(200);
  });

  $('[data-focus]').focus();

  $('[data-powertip]')
    .attr('title', '')
    .powerTip({
      placement: 's',
      smartPlacement: true,
      mouseOnToPopup: true
    });

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

  updateContentClickHandlers();

  if ($('#search-input').length)
    setupSearch();

  console.log(
    '\n' +
    '    ___ __\n' +
    '   / (_) /_    ________ _   __(_)__ _      _______\n' +
    '  / / / __ \\  / ___/ _ \\ | / / / _ \\ | /| / / ___/\n' +
    ' / / / /_/ / / /  /  __/ |/ / /  __/ |/ |/ (__  )\n' +
    '/_/_/_.___(_)_/   \\___/|___/_/\\___/|__/|__/____/\n' +
    'Happy hacking! https://github.com/permacommons/lib.reviews\n\n'
  );

  initialized = true;
  return libreviews;
}

const libreviews = {
  msg,
  resolveString,
  getLanguageIDSpan,
  trimInput,
  enableRequiredGroup,
  disableRequiredGroup,
  repaintFocusedHelp,
  addHelpListeners,
  updateContentClickHandlers,
  validateURL,
  urlHasSupportedProtocol,
  activeRTEs: {}
};

// Auto-initialize and expose globally when loaded in browser
if (typeof window !== 'undefined') {
  const api = initializeLibreviews();
  if (!window.libreviews)
    window.libreviews = api;
}

export { msg, resolveString, getLanguageIDSpan, trimInput, enableRequiredGroup, disableRequiredGroup, repaintFocusedHelp, addHelpListeners, updateContentClickHandlers, validateURL, urlHasSupportedProtocol, initializeLibreviews };

export default libreviews;
