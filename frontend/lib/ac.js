/**
 * Based on the MIT-licensed remote-ac project (https://github.com/danqing/autocomplete).
 * We maintain an in-repo fork to support accessibility improvements and Node 22 tooling.
 */
const globalRoot =
  typeof globalThis !== 'undefined'
    ? globalThis
    : typeof self !== 'undefined'
      ? self
      : typeof window !== 'undefined'
        ? window
        : undefined;

('use strict');

const DEFAULT_DELAY_MS = 300;
const DEFAULT_MIN_LENGTH = 1;

/**
 * Lightweight autocomplete widget tailored for lib.reviews adapters.
 * Exposes the same surface as the legacy remote-ac package while improving
 * keyboard and assistive technology support.
 *
 * @class
 */
class Autocomplete {
  constructor(inputEl, urlFn, requestFn, resultFn, rowFn, triggerFn, anchorEl) {
    if (!inputEl || typeof inputEl !== 'object')
      throw new TypeError('Autocomplete requires a DOM input element.');

    this.inputEl = inputEl;
    this.anchorEl = anchorEl || inputEl;

    this.urlBuilderFn = urlFn || null;
    this.requestFn = requestFn || null;
    this.resultFn = resultFn || null;
    this.rowFn = rowFn || null;
    this.triggerFn = triggerFn || null;

    this.primaryTextKey = 'title';
    this.secondaryTextKey = 'subtitle';
    this.delay = DEFAULT_DELAY_MS;
    this.minLength = DEFAULT_MIN_LENGTH;
    this.cssPrefix = 'ac-';
    this.adapter = null;

    this.value = '';
    this.results = [];
    this.rows = [];
    this.selectedIndex = -1;
    this.isRightArrowComplete = false;
    this.isMounted = false;

    this.el = null;
    this.rowWrapperEl = null;
    this._abortController = null;
    this._listId = `ac-list-${Math.random().toString(36).slice(2, 9)}`;
    this._rowIdPrefix = `${this._listId}-row`;

    this.timeoutID = null;
    this.latestQuery = undefined;

    this.keydownHandler = this.handleKeydown.bind(this);
    this.inputHandler = this.handleInput.bind(this);
    this.clickHandler = this.handleClick.bind(this);
    this.resizeHandler = this.position.bind(this);
    this.mountHandler = this.mount.bind(this);

    this.activate();
    this.inputEl.setAttribute('aria-autocomplete', 'list');
  }

  activate() {
    this.inputEl.addEventListener('focus', this.mountHandler);
  }

  deactivate() {
    this.unmount();
    this.inputEl.removeEventListener('focus', this.mountHandler);
  }

  mount() {
    if (this.isMounted) return;

    if (!this.el) {
      this.el = Autocomplete.createEl('div', this.getCSS('WRAPPER'));
      this.el.setAttribute('role', 'listbox');
      this.el.id = this._listId;
      document.body.appendChild(this.el);
    } else {
      this.el.style.display = '';
    }

    if (!this.rowWrapperEl) {
      this.rowWrapperEl = Autocomplete.createEl('div', this.getCSS('ROW_WRAPPER'));
      this.el.appendChild(this.rowWrapperEl);
    }

    const win = Autocomplete._getWindow();
    if (win) {
      win.addEventListener('keydown', this.keydownHandler);
      win.addEventListener('input', this.inputHandler, true);
      win.addEventListener('resize', this.resizeHandler);
      if (Autocomplete.isMobileSafari()) win.addEventListener('touchend', this.clickHandler);
      else win.addEventListener('click', this.clickHandler);
    }

    this.inputEl.setAttribute('aria-expanded', 'true');
    this.inputEl.setAttribute('aria-owns', this._listId);

    this.position();
    this.render();
    this.isMounted = true;

    const viewportWidth = Autocomplete._getViewportWidth();
    if (viewportWidth !== null && viewportWidth < 500) {
      Autocomplete._withFallback(
        () => {
          this.inputEl.scrollIntoView({ block: 'nearest' });
        },
        () => {
          this.inputEl.scrollIntoView();
        }
      );
    }
  }

  unmount() {
    if (!this.isMounted) return;

    const win = Autocomplete._getWindow();
    if (win) {
      win.removeEventListener('keydown', this.keydownHandler);
      win.removeEventListener('input', this.inputHandler, true);
      win.removeEventListener('resize', this.resizeHandler);
      if (Autocomplete.isMobileSafari()) win.removeEventListener('touchend', this.clickHandler);
      else win.removeEventListener('click', this.clickHandler);
    }

    if (this.el) this.el.style.display = 'none';

    this.abortPendingRequest();

    this.inputEl.removeAttribute('aria-activedescendant');
    this.inputEl.setAttribute('aria-expanded', 'false');
    this.isMounted = false;
  }

  position() {
    if (!this.el) return;

    const rect = this.anchorEl.getBoundingClientRect();
    const offset = Autocomplete.findPosition(this.anchorEl);
    this.el.style.top = `${offset.top + rect.height}px`;
    this.el.style.left = `${offset.left}px`;
    this.el.style.width = `${rect.width}px`;
  }

  handleKeydown(event) {
    switch (event.keyCode) {
      case Autocomplete.KEYCODE.UP:
        event.preventDefault();
        this.setSelectedIndex(this.selectedIndex - 1);
        break;
      case Autocomplete.KEYCODE.DOWN:
        event.preventDefault();
        this.setSelectedIndex(this.selectedIndex + 1);
        break;
      case Autocomplete.KEYCODE.RIGHT:
        if (this.selectedIndex > -1 && this.results[this.selectedIndex]) {
          this.inputEl.value = this.results[this.selectedIndex][this.primaryTextKey];
          this.isRightArrowComplete = true;
        }
        break;
      case Autocomplete.KEYCODE.ENTER:
        if (this.selectedIndex > -1) {
          event.preventDefault();
          this.trigger(event);
        }
        break;
      case Autocomplete.KEYCODE.ESC:
        this.inputEl.blur();
        this.unmount();
        break;
      default:
        break;
    }
  }

  handleInput() {
    this.value = this.inputEl.value;
    this.isRightArrowComplete = false;
    if (this.timeoutID) clearTimeout(this.timeoutID);
    this.timeoutID = setTimeout(() => this.requestMatch(), this.delay);
  }

  setSelectedIndex(index) {
    if (!this.rows.length) return;

    let nextIndex = index;
    if (nextIndex === this.selectedIndex) return;
    if (nextIndex >= this.rows.length) nextIndex = nextIndex - this.rows.length;
    if (nextIndex < 0) nextIndex = this.rows.length + nextIndex;

    if (this.selectedIndex >= 0 && this.rows[this.selectedIndex]) {
      const previousRow = this.rows[this.selectedIndex];
      previousRow.classList.remove('selected');
      this._removeClasses(previousRow, 'SELECTED_ROW');
      this._addClasses(previousRow, 'ROW');
      previousRow.setAttribute('aria-selected', 'false');
    }

    const row = this.rows[nextIndex];
    this._addClasses(row, 'SELECTED_ROW');
    row.classList.add('selected');
    row.setAttribute('aria-selected', 'true');
    this.selectedIndex = nextIndex;
    this.inputEl.setAttribute('aria-activedescendant', row.id);

    if (this.isRightArrowComplete)
      this.inputEl.value = this.results[this.selectedIndex][this.primaryTextKey];
  }

  handleClick(event) {
    const target = event.target;
    if (!target) return;

    if (target === this.inputEl) return;

    if (this.el && this.el.contains(target)) {
      const row = target.closest('[data-rid]');
      if (!row) return;

      const rowId = parseInt(row.getAttribute('data-rid'), 10);
      if (Number.isNaN(rowId)) return;

      this.selectedIndex = rowId;
      this.trigger(event);
      return;
    }

    this.unmount();
  }

  trigger(event) {
    if (this.selectedIndex < 0 || !this.results[this.selectedIndex]) return;

    const result = this.results[this.selectedIndex];
    this.value = result[this.primaryTextKey];
    this.inputEl.value = this.value;
    this.inputEl.blur();

    if (typeof this.triggerFn === 'function') this.triggerFn(result, event);

    this.unmount();
  }

  requestMatch() {
    if (typeof this.requestFn === 'function') {
      this.requestFn(this.value);
      return;
    }

    if (!this.urlBuilderFn) return;

    this.abortPendingRequest();

    if (typeof this.value !== 'string' || this.value.length < this.minLength) {
      this.results = [];
      this.selectedIndex = -1;
      this.render();
      return;
    }

    if (typeof fetch !== 'function') {
      throw new Error('No fetch implementation available for autocomplete.');
    }

    this._abortController = typeof AbortController === 'function' ? new AbortController() : null;
    const signal = this._abortController ? this._abortController.signal : undefined;

    fetch(this.urlBuilderFn(this.value), { signal })
      .then(response => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      })
      .then(results => {
        this.results = Array.isArray(results) ? results : [];
        this.render();
      })
      .catch(error => {
        if (error && error.name === 'AbortError') return;
        this.results = [];
        this.render();
      });
  }

  abortPendingRequest() {
    if (this._abortController) {
      this._abortController.abort();
      this._abortController = null;
    }
  }

  render() {
    this.selectedIndex = -1;
    this.rows = [];

    if (!this.rowWrapperEl) return;

    this.rowWrapperEl.innerHTML = '';

    if (this.results.length) {
      const fragment = document.createDocumentFragment();
      this.results.forEach((result, index) => {
        let row = null;
        if (typeof this.rowFn === 'function') {
          row = this.rowFn(result);
        } else {
          row = this.createRow(index);
        }

        if (!row) return;

        this._addClasses(row, 'ROW');
        row.setAttribute('data-rid', index);
        row.setAttribute('role', 'option');
        row.setAttribute('aria-selected', 'false');
        row.id = `${this._rowIdPrefix}-${index}`;

        fragment.appendChild(row);
        this.rows.push(row);
      });
      this.rowWrapperEl.style.display = '';
      this.rowWrapperEl.appendChild(fragment);
    } else {
      this.rowWrapperEl.style.display = 'none';
    }
  }

  createRow(index) {
    const data = this.results[index];
    const element = Autocomplete.createEl('div', this.getCSS('ROW'));

    const primary = Autocomplete.createEl('span', this.getCSS('PRIMARY_SPAN'));
    primary.appendChild(Autocomplete.createMatchTextEls(this.value, data[this.primaryTextKey]));
    element.appendChild(primary);

    const secondary = data[this.secondaryTextKey];
    if (secondary)
      element.appendChild(Autocomplete.createEl('span', this.getCSS('SECONDARY_SPAN'), secondary));

    return element;
  }

  getCSS(key) {
    if (!Object.prototype.hasOwnProperty.call(Autocomplete.CLASS, key))
      throw new Error(`CSS element ID "${key}" not recognized.`);
    return `${this.cssPrefix}${Autocomplete.CLASS[key]}`;
  }

  _addClasses(element, key) {
    if (!element) return;

    const classes = this.getCSS(key).split(/\s+/);
    classes.forEach(cls => {
      if (cls) element.classList.add(cls);
    });
  }

  _removeClasses(element, key) {
    if (!element) return;

    const classes = this.getCSS(key).split(/\s+/);
    classes.forEach(cls => {
      if (cls) element.classList.remove(cls);
    });
  }

  static isMobileSafari() {
    /* istanbul ignore next */
    const nav = Autocomplete._getNavigator();
    if (!nav || !nav.userAgent) return false;
    const ua = nav.userAgent;
    const iOS = /iPad|iPhone/.test(ua);
    return iOS && /WebKit/.test(ua) && !/CriOS/.test(ua);
  }

  static createMatchTextEls(input, complete) {
    const fragment = document.createDocumentFragment();
    if (!complete) return fragment;

    const trimmedInput = input ? input.trim() : '';
    const len = trimmedInput.length;
    const lowerComplete = complete.toLowerCase();
    const lowerInput = trimmedInput.toLowerCase();
    const index = len ? lowerComplete.indexOf(lowerInput) : -1;

    if (index === 0) {
      fragment.appendChild(Autocomplete.createEl('b', null, complete.substring(0, len)));
      fragment.appendChild(Autocomplete.createEl('span', null, complete.substring(len)));
    } else if (index > 0) {
      fragment.appendChild(Autocomplete.createEl('span', null, complete.substring(0, index)));
      fragment.appendChild(
        Autocomplete.createEl('b', null, complete.substring(index, index + len))
      );
      fragment.appendChild(Autocomplete.createEl('span', null, complete.substring(index + len)));
    } else {
      fragment.appendChild(Autocomplete.createEl('span', null, complete));
    }

    return fragment;
  }

  static createEl(tag, className, textContent) {
    const element = document.createElement(tag);
    if (className)
      className
        .split(/\s+/)
        .filter(Boolean)
        .forEach(cls => element.classList.add(cls));
    if (textContent) element.appendChild(document.createTextNode(textContent));
    return element;
  }

  static findPosition(el) {
    const rect = el.getBoundingClientRect();
    const win = Autocomplete._getWindow();
    const doc = el.ownerDocument || (win && win.document);
    const pageYOffset =
      win && typeof win.pageYOffset === 'number'
        ? win.pageYOffset
        : doc && doc.documentElement
          ? doc.documentElement.scrollTop
          : 0;
    const pageXOffset =
      win && typeof win.pageXOffset === 'number'
        ? win.pageXOffset
        : doc && doc.documentElement
          ? doc.documentElement.scrollLeft
          : 0;
    const top = rect.top + pageYOffset;
    const left = rect.left + pageXOffset;
    return { left, top };
  }

  static encodeQuery(obj) {
    if (!obj || typeof obj !== 'object') return '';
    return Object.keys(obj)
      .map(key => `${encodeURIComponent(key)}=${encodeURIComponent(obj[key])}`)
      .join('&');
  }

  static _getWindow() {
    if (typeof window !== 'undefined') return window;
    if (globalRoot && globalRoot.window) return globalRoot.window;
    return null;
  }

  static _getNavigator() {
    if (typeof navigator !== 'undefined') return navigator;
    const win = Autocomplete._getWindow();
    if (win && win.navigator) return win.navigator;
    return null;
  }

  static _getViewportWidth() {
    const win = Autocomplete._getWindow();
    if (!win) return null;
    return Math.max(
      win.document && win.document.documentElement ? win.document.documentElement.clientWidth : 0,
      win.innerWidth || 0
    );
  }

  static _withFallback(primaryFn, fallbackFn) {
    try {
      primaryFn();
    } catch (_error) {
      fallbackFn();
    }
  }
}

Autocomplete.KEYCODE = {
  ENTER: 13,
  ESC: 27,
  LEFT: 37,
  UP: 38,
  RIGHT: 39,
  DOWN: 40,
};

Autocomplete.CLASS = {
  WRAPPER: 'wrap',
  ROW_WRAPPER: 'rwrap',
  ROW: 'row',
  SELECTED_ROW: 'row selected',
  PRIMARY_SPAN: 'pr',
  SECONDARY_SPAN: 'sc',
  MOBILE_INPUT: 'minput',
  CANCEL: 'cancel',
};

if (globalRoot && !globalRoot.AC) globalRoot.AC = Autocomplete;

export default Autocomplete;
