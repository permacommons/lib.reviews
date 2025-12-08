import $ from './lib/jquery.js';
import 'jquery-powertip';
import 'jquery-modal';
import './styles/vendor.css';
import './styles/style.less';
import type { EditorView } from 'prosemirror-view';
import Autocomplete from './lib/ac.js';
import initializeSisyphus from './lib/sisyphus.js';

/**
 * Options for message parameterization.
 */
export interface MessageOptions {
  /**
   * Access key to append to the message.
   */
  accessKey?: string;
  /**
   * Single string parameter for %s placeholders.
   */
  stringParam?: string | number;
  /**
   * Multiple ordered string parameters for %1$s, %2$s, etc.
   */
  stringParams?: Array<string | number>;
  /**
   * Single numeric parameter for %d placeholders.
   */
  numberParam?: number;
  /**
   * Multiple ordered numeric parameters for %1$d, %2$d, etc.
   */
  numberParams?: number[];
}

/**
 * Multi-language string object.
 */
export interface MLString {
  [languageCode: string]: string;
}

/**
 * Search suggestion result from the API.
 */
export interface SearchSuggestion {
  title: string;
  urlID: string;
  description?: string;
  language?: string;
}

/**
 * API response from the thing suggestion endpoint.
 */
export interface SuggestResponse {
  results?: Record<
    string,
    Array<{
      _id: string;
      text: string;
      urlID: string;
      description?: MLString;
    }>
  >;
}

/**
 * Active rich text editors by ID.
 */
export interface RichTextEditorHandle {
  editorView?: EditorView;
  enterFullScreen?: () => void;
  exitFullScreen?: () => void;
  nuke?: () => void;
  reRender: () => void;
}

export interface ActiveRTEs {
  [editorId: string]: RichTextEditorHandle;
}

/**
 * Public API exposed by libreviews.
 */
export interface LibreviewsAPI {
  msg: typeof msg;
  resolveString: typeof resolveString;
  getLanguageIDSpan: typeof getLanguageIDSpan;
  trimInput: typeof trimInput;
  setupPasswordReveal: typeof setupPasswordReveal;
  enableRequiredGroup: typeof enableRequiredGroup;
  disableRequiredGroup: typeof disableRequiredGroup;
  repaintFocusedHelp: typeof repaintFocusedHelp;
  addHelpListeners: typeof addHelpListeners;
  updateContentClickHandlers: typeof updateContentClickHandlers;
  validateURL: typeof validateURL;
  urlHasSupportedProtocol: typeof urlHasSupportedProtocol;
  activeRTEs: ActiveRTEs;
}

let initialized = false;

initializeSisyphus();

/**
 * Retrieves a localized message from the global config by key, with optional
 * parameter substitution.
 *
 * @param messageKey - Key for the message in the global config.messages object
 * @param options - Optional parameters for interpolation and access keys
 * @returns The formatted message string, or ?messageKey? if not found
 */
export function msg(messageKey: string, options?: MessageOptions): string {
  if (!window.config || !window.config.messages || !window.config.messages[messageKey])
    return `?${messageKey}?`;

  let rv = window.config.messages[messageKey];

  if (typeof options !== 'object') return rv;

  const { accessKey, stringParam, stringParams, numberParam, numberParams } = options;

  if (stringParam !== undefined) rv = processSingleParam(rv, 's', String(stringParam));

  if (Array.isArray(stringParams)) rv = processOrderedParams(rv, 's', stringParams);

  if (numberParam !== undefined) rv = processSingleParam(rv, 'd', Number(numberParam));

  if (Array.isArray(numberParams)) rv = processOrderedParams(rv, 'd', numberParams);

  if (accessKey && window.config.messages && window.config.messages['accesskey'])
    rv += '\n' + window.config.messages['accesskey'].replace('%s', accessKey);

  return rv;

  function processSingleParam(str: string, typeStr: string, param: string | number): string {
    return str.replace(`%${typeStr}`, String(param));
  }

  function processOrderedParams(
    str: string,
    typeStr: string,
    paramArr: Array<string | number>
  ): string {
    paramArr.forEach((orderedParam, index) => {
      index++;
      str = str.replace(new RegExp(`%${index}\\$${typeStr}`, 'g'), String(orderedParam));
    });
    return str;
  }
}

/**
 * Resolves a multi-language string to a single language, preferring the
 * specified language but falling back to English, then any available language.
 *
 * @param lang - Preferred language code
 * @param strObj - Multi-language string object
 * @returns Resolved string or undefined if object is empty
 */
export function resolveString(lang: string, strObj?: MLString): string | undefined {
  if (strObj === undefined) return undefined;

  // Try the requested language
  if (typeof strObj[lang] === 'string' && strObj[lang] !== '') return strObj[lang];

  // Try fallback languages (English and undetermined)
  const fallbacks = ['en', 'und'];
  for (let fallback of fallbacks) {
    if (typeof strObj[fallback] === 'string' && strObj[fallback] !== '') return strObj[fallback];
  }

  // Last resort: try any available language
  for (let k in strObj) {
    if (typeof strObj[k] === 'string' && strObj[k] !== '') return strObj[k];
  }

  return undefined;
}

/**
 * Creates a styled language identifier badge for a given language code.
 *
 * @param lang - ISO language code
 * @returns jQuery element containing the language badge
 */
export function getLanguageIDSpan(lang: string): JQuery<HTMLSpanElement> {
  if (typeof lang !== 'string') throw new Error('Need valid language identifier.');

  let title = msg(`language ${lang} composite name`);
  return $(`<span class="language-identifier" title="${title}">`)
    .text(lang.toUpperCase())
    .prepend(
      '<span class="fa fa-fw fa-globe language-identifier-icon">&nbsp;</span>'
    ) as JQuery<HTMLSpanElement>;
}

/**
 * Trims whitespace from the value of an input or textarea element.
 * Intended as a jQuery event handler bound with `this` context.
 */
export function trimInput(this: HTMLInputElement | HTMLTextAreaElement): void {
  this.value = this.value.trim();
}

/**
 * Enables a group of required field indicators and marks inputs as required.
 *
 * @param groupID - Data attribute value identifying the required group
 */
export function enableRequiredGroup(groupID: string): void {
  $(`span[data-required-indicator-group="${groupID}"]`).addClass('required').removeClass('hidden');
  $(`[data-required-input-group="${groupID}"]`).attr('data-required', '');
}

/**
 * Disables a group of required field indicators and removes required status.
 *
 * @param groupID - Data attribute value identifying the required group
 */
export function disableRequiredGroup(groupID: string): void {
  $(`span[data-required-indicator-group="${groupID}"]`).addClass('hidden').removeClass('required');
  $(`[data-required-input-group="${groupID}"]`).removeAttr('data-required');
}

/**
 * Repaints the help text for the currently focused input element.
 * Used to adjust positioning after DOM mutations.
 */
export const repaintFocusedHelp = (): void => {
  let $focused = $(':focus');
  if (!$focused.length) return;

  let id = $focused.attr('data-acts-as') || $focused[0].id;
  if (id && $(`[data-help-for=${id}]`).length) showInputHelp.apply($focused[0]);
};

/**
 * Attaches focus/blur listeners and mutation observers to display contextual
 * help for an input field.
 *
 * @param $input - jQuery-wrapped input or textarea element
 */
export function addHelpListeners($input: JQuery<HTMLElement>): void {
  $input.focus(showInputHelp);
  $input.blur(hideInputHelp);
  if (typeof MutationObserver !== 'undefined') {
    new MutationObserver(repaintFocusedHelp).observe($input[0], {
      attributes: true,
      attributeFilter: ['style'],
    });
  }
}

/**
 * Re-attaches click handlers for content warning toggles.
 */
export const updateContentClickHandlers = (): void => {
  $('summary.content-warning-notice').click(toggleDangerousContent);
};

/**
 * Validates a URL using a comprehensive regex pattern.
 *
 * @param url - URL string to validate
 * @returns True if the URL is valid
 */
export function validateURL(url: string): boolean {
  const urlRegex =
    /^(https?|ftp):\/\/(((([a-z]|\d|-|\.|_|~|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])|(%[\da-f]{2})|[!$&'()*+,;=]|:)*@)?(((\d|[1-9]\d|1\d\d|2[0-4]\d|25[0-5])\.(\d|[1-9]\d|1\d\d|2[0-4]\d|25[0-5])\.(\d|[1-9]\d|1\d\d|2[0-4]\d|25[0-5])\.(\d|[1-9]\d|1\d\d|2[0-4]\d|25[0-5]))|((([a-z]|\d|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])|(([a-z]|\d|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])([a-z]|\d|-|\.|_|~|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])*([a-z]|\d|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])))\.)+(([a-z]|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])|(([a-z]|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])([a-z]|\d|-|\.|_|~|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])*([a-z]|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])))\.?)(:\d*)?)(\/((([a-z]|\d|-|\.|_|~|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])|(%[\da-f]{2})|[!$&'()*+,;=]|:|@)+(\/(([a-z]|\d|-|\.|_|~|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])|(%[\da-f]{2})|[!$&'()*+,;=]|:|@)*)*)?)?(\?((([a-z]|\d|-|\.|_|~|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])|(%[\da-f]{2})|[!$&'()*+,;=]|:|@)|[\uE000-\uF8FF]|\/|\?)*)?(#((([a-z]|\d|-|\.|_|~|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])|(%[\da-f]{2})|[!$&'()*+,;=]|:|@)|\/|\?)*)*$/i;
  return urlRegex.test(url);
}

/**
 * Checks if a URL begins with a supported protocol (http, https, or ftp).
 *
 * @param url - URL string to check
 * @returns True if the URL has a supported protocol
 */
export function urlHasSupportedProtocol(url: string): boolean {
  let protocolRegex = /^(https?|ftp):\/\//;
  return protocolRegex.test(url);
}

/**
 * Toggles visibility of dangerous content with slide animation.
 * Handler for content warning notices.
 */
function toggleDangerousContent(this: HTMLElement, event: JQuery.Event): void {
  if ($(this).parent().is('[open]')) {
    $(this)
      .next('.dangerous-content')
      .slideUp(200, () => {
        $(this).parent().removeAttr('open');
      });
  } else {
    $(this).parent().attr('open', '');
    $(this).next('.dangerous-content').slideDown(200);
  }
  event.preventDefault();
}

/**
 * Initializes the autocomplete widget for the global search input.
 */
function setupSearch(): void {
  const inputEl = $('#search-input')[0] as HTMLInputElement;
  let ac = new Autocomplete(inputEl, null, requestFn, null, rowFn, triggerFn);
  ac.delay = 0;

  // Store reference for potential manual initialization
  (inputEl as any)._autocomplete = ac;

  // If input is already focused (user started typing before JS loaded),
  // manually mount and trigger search for current value
  if (document.activeElement === inputEl) {
    ac.mount();
    if (inputEl.value) {
      ac.inputHandler();
    }
  }

  function triggerFn(result: SearchSuggestion | null, event?: Event): void {
    if (!result || !result.urlID) return;

    if (event && typeof (event as Event).preventDefault === 'function') event.preventDefault();

    window.location.href = `/${result.urlID}`;
  }

  function rowFn(this: Autocomplete, row: SearchSuggestion): HTMLDivElement {
    const $row = $('<div>');

    const $primary = $('<span>')
      .addClass(this.getCSS('PRIMARY_SPAN'))
      .append(
        $(
          Autocomplete.createMatchTextEls(
            this.value,
            row[this.primaryTextKey as keyof SearchSuggestion] as string
          )
        )
      )
      .appendTo($row);

    if (row.language)
      $primary.append(getLanguageIDSpan(row.language).addClass('language-identifier-search-row'));

    if (row.description) {
      $('<span>').addClass(this.getCSS('SECONDARY_SPAN')).text(row.description).appendTo($row);
    }

    return $row[0] as HTMLDivElement;
  }

  function requestFn(this: Autocomplete, query: string): void {
    let time = Date.now();
    this.latestQuery = time;
    this.results = [];
    query = query.trim();
    if (query) {
      $.get(`/api/suggest/thing/${encodeURIComponent(query)}`).done((res: SuggestResponse) => {
        if (time < this.latestQuery) return;

        this.results = [];
        if (res.results) {
          let seenIDs: string[] = [];

          let processLabelKey = (labelKey: string, labelLanguage: string) => {
            for (let label of res.results![labelKey]) {
              if (seenIDs.indexOf(label._id) !== -1) continue;
              seenIDs.push(label._id);

              let suggestion: SearchSuggestion = {
                title: label.text,
                urlID: label.urlID,
                description: resolveString(window.config?.language || 'en', label.description),
              };
              if (labelLanguage !== window.config?.language) suggestion.language = labelLanguage;

              this.results.push(suggestion);
            }
            Reflect.deleteProperty(res.results!, labelKey);
          };

          let myLabelKey = `labels-${window.config?.language || 'en'}`;
          if (Array.isArray(res.results[myLabelKey]) && res.results[myLabelKey].length)
            processLabelKey(myLabelKey, window.config?.language || 'en');

          for (let labelKey in res.results) {
            let labelLanguage = (labelKey.match(/labels-(.*)/) || [])[1];
            if (!labelLanguage) continue;
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

/**
 * Displays contextual help for a focused input element.
 * Handler bound with `this` context to the input element.
 */
function showInputHelp(this: HTMLElement): void {
  let id = $(this).attr('data-acts-as') || this.id;
  $('.help-text').hide();
  $(`#${id}-help`).show();

  if (this.getBoundingClientRect && $(`label[for=${id}]`)[0]) {
    let posHelp;
    let posLabel;
    posLabel = $(`label[for=${id}]`)[0].getBoundingClientRect();
    posHelp = $(`#${id}-help`)[0].getBoundingClientRect();

    let maxRight: number | undefined;
    $(this)
      .parents('form')
      .find('input,textarea')
      .each(function () {
        let eleRight = this.getBoundingClientRect().right;
        if (maxRight === undefined || maxRight < eleRight) maxRight = eleRight;
      });

    if (
      posHelp.left > posLabel.right &&
      document.body.clientWidth >= Math.ceil(posLabel.width) + Math.ceil(posHelp.width) + 5
    ) {
      let newTopPos = Math.floor(window.scrollY) + Math.floor(posLabel.top);
      let newLeftPos = maxRight! + 5;
      let style = `position:absolute;top:${newTopPos}px;display:inline-block;left:${newLeftPos}px;`;
      $(`#${id}-help`).attr('style', style);
    } else {
      $(`#${id}-help`).attr('style', 'display:inline-block;');
    }
  }
}

/**
 * Hides contextual help when an input loses focus, unless the help text
 * itself is being hovered.
 * Handler bound with `this` context to the input element.
 */
function hideInputHelp(this: HTMLElement): void {
  let id = $(this).attr('data-acts-as') || this.id;
  if (!$('.help-text:hover').length) $(`#${id}-help`).hide();
}

/**
 * Adds password reveal toggle functionality to password inputs.
 */
function setupPasswordReveal(): void {
  const showLabel = msg('show password');
  const hideLabel = msg('hide password');

  $('.password-reveal-toggle').on('click', function () {
    const toggle = $(this);
    const input = toggle.siblings('input[type="password"], input[type="text"]').first();
    if (!input.length) return;

    const isHidden = input.attr('type') === 'password';
    const nextType = isHidden ? 'text' : 'password';
    input.attr('type', nextType);
    const label = isHidden ? hideLabel : showLabel;
    const icon = toggle.find('.fa');

    // Toggle icon between eye and eye-slash
    if (isHidden) {
      icon.removeClass('fa-eye').addClass('fa-eye-slash');
    } else {
      icon.removeClass('fa-eye-slash').addClass('fa-eye');
    }

    // Update text content (after the icon span)
    const iconHTML = icon.prop('outerHTML');
    toggle.html(iconHTML + label);
    toggle.attr('aria-label', label);
    toggle.attr('aria-pressed', String(isHidden));
    input.trigger('focus');
  });
}

/**
 * Adds custom jQuery plugin methods for form validation and UI patterns.
 */
function initializePlugins(): void {
  $.fn.getEmptyInputs = function () {
    return this.filter(function () {
      return this.value === undefined || String(this.value) === '';
    });
  };

  $.fn.highlightLabels = function (indicatorSelector?: string) {
    if (!indicatorSelector) indicatorSelector = 'span.required';

    this.each(function () {
      $(`label[for="${this.id}"] ${indicatorSelector}`).show();
    });

    return this;
  };

  $.fn.attachRequiredFieldHandler = function (options) {
    if (!options) options = {};

    let indicatorSelector = options.indicatorSelector || 'span.required';
    let requiredFieldsMessage = options.requiredFieldMessage || '#required-fields-message';
    let formErrorMessage = options.formErrorMessage || '#form-error-message';
    let formSelector = options.formSelector ? options.formSelector + ' ' : '';
    let validationErrorSelector =
      options.validationErrorSelector || `${formSelector}.validation-error:visible`;
    let cb = options.callback;

    this.click(requiredFieldHandler);

    function requiredFieldHandler(event: JQuery.ClickEvent) {
      $(
        `${formSelector}${requiredFieldsMessage},${formSelector}${formErrorMessage},${formSelector}label ${indicatorSelector}`
      ).hide();

      let $emptyFields = $(
        `${formSelector}input[data-required],${formSelector}textarea[data-required],${formSelector}select[data-required]`
      )
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

      if (cb) cb.call(this, event);
    }

    return this;
  };

  $.fn.lockTab = function () {
    const $inputs = this.find('select, input, textarea, button, a, [data-focusable]').filter(
      ':visible'
    );
    const $firstInput = $inputs.first();
    const $lastInput = $inputs.last();

    $firstInput.focus();

    $lastInput.on('keydown', e => {
      if (e.which === 9 && !e.shiftKey) {
        e.preventDefault();
        $firstInput.focus();
      }
    });

    $firstInput.on('keydown', e => {
      if (e.which === 9 && e.shiftKey) {
        e.preventDefault();
        $lastInput.focus();
      }
    });

    return this;
  };

  $.fn.toggleSwitcher = function () {
    let $selectedIndicator = $(
      '<span class="fa fa-fw fa-check-circle switcher-selected-indicator">&nbsp;</span>'
    );

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

    return this;
  };

  $.fn.conditionalSwitcherClick = function (
    eventHandler: (this: HTMLElement, event: JQuery.Event) => void
  ) {
    this.click(function (event) {
      if ($(this).hasClass('switcher-option-selected')) return false;
      $(this).parent().toggleSwitcher();
      eventHandler.call(this, event);
    });

    return this;
  };
}

/**
 * Initializes the libreviews frontend library with all event handlers,
 * plugins, and UI enhancements. Safe to call multiple times; will only
 * initialize once.
 *
 * @returns The public libreviews API
 */
function initializeLibreviews(): LibreviewsAPI {
  if (initialized) return libreviews;

  initializePlugins();
  initializeSisyphus();

  $('input[type="radio"][data-enable-required-group]').focus(function () {
    enableRequiredGroup($(this).attr('data-enable-required-group')!);
  });

  $('input[type="radio"][data-disable-required-group]').focus(function () {
    disableRequiredGroup($(this).attr('data-disable-required-group')!);
  });

  $('button[data-dismiss-element]').click(function (event) {
    let id = $(this).attr('data-dismiss-element');
    $(`#${id}`).fadeOut(200);
    event.preventDefault();
  });

  $('button[data-suppress-notice]').click(function (event) {
    let id = $(this).attr('data-suppress-notice');
    $.ajax({
      type: 'POST',
      url: '/api/actions/suppress-notice',
      data: JSON.stringify({
        noticeType: id,
      }),
      contentType: 'application/json',
      dataType: 'json',
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

  setupPasswordReveal();

  $('.long-text h2,.long-text h3').each(function () {
    $(this).prepend(
      `<a href="#${this.id}" class="fragment-link no-print"><span class="fa fa-link"></span></a>`
    );
  });

  $('.expand-link').click(function () {
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

  $('.expand-link').keyup(e => {
    if (e.which == 13) $('.expand-link').trigger('click');
  });

  if ($('[data-help-for]').length) {
    $('[data-help-for]').each(function () {
      let inputID = $(this).attr('data-help-for');
      let $input = $(`#${inputID}`) as JQuery<HTMLInputElement | HTMLTextAreaElement>;
      addHelpListeners($input);
    });

    $(window).resize(repaintFocusedHelp);
  }

  $('[data-show]').focus(function () {
    $(`#${$(this).attr('data-show')}`).slideDown(200);
  });

  $('[data-hide]').focus(function () {
    $(`#${$(this).attr('data-hide')}`).slideUp(200);
  });

  $('[data-focus]').focus();

  $('[data-powertip]').attr('title', '').powerTip({
    placement: 's',
    smartPlacement: true,
    mouseOnToPopup: true,
  });

  $('[data-copy]').click(function () {
    let copySourceID = $(this).attr('data-copy');
    let copySource = $(`#${copySourceID}`)[0];

    let range = document.createRange();
    range.selectNode(copySource);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    try {
      document.execCommand('copy');
    } catch {
      console.error('Copying not supported in your browser.');
    }
  });

  updateContentClickHandlers();

  if ($('#search-input').length) setupSearch();

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

const libreviews: LibreviewsAPI = {
  msg,
  resolveString,
  getLanguageIDSpan,
  trimInput,
  setupPasswordReveal,
  enableRequiredGroup,
  disableRequiredGroup,
  repaintFocusedHelp,
  addHelpListeners,
  updateContentClickHandlers,
  validateURL,
  urlHasSupportedProtocol,
  activeRTEs: {},
};

// Auto-initialize and expose globally when loaded in browser
if (typeof window !== 'undefined') {
  const api = initializeLibreviews();
  if (!window.libreviews) window.libreviews = api;
}

export { initializeLibreviews };

export default libreviews;
