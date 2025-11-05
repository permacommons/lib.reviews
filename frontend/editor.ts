/* eslint prefer-reflect: "off" */

import 'prosemirror-view/style/prosemirror.css';
import 'prosemirror-menu/style/menu.css';
import './styles/editor-overrides.css';

import $ from './lib/jquery.js';

// This file integrates the ProseMirror RTE for textareas that have the
// data-markdown attribute set. The switcher between the two modes is rendered
// server-side from the views/partial/editor-switcher.hbs template.

// ProseMirror editor components
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { keymap } from 'prosemirror-keymap';
import { baseKeymap } from 'prosemirror-commands';
import { menuBar } from 'prosemirror-menu';

// For indicating the drop target when dragging a text selection
import { dropCursor } from 'prosemirror-dropcursor';
import { history } from 'prosemirror-history';

// Custom input rules, e.g. # for headline
import { buildInputRules } from './editor-inputrules.ts';

// Custom keymap
import { getExtendedKeymap } from './editor-extended-keymap.ts';

// Custom menu
import { buildMenuItems } from './editor-menu.ts';

// For tracking contentEditable selection
import { saveSelection, restoreSelection, type SavedSelectionRange } from './editor-selection.ts';

// For parsing, serializing and tokenizing markdown including our custom
// markup for spoiler/NSFW warnings
import { markdownParser, markdownSerializer, markdownSchema } from './editor-markdown.ts';
import libreviews, { addHelpListeners, msg, type RichTextEditorHandle } from './libreviews.ts';

declare module 'prosemirror-view' {
  interface EditorView {
    disable(): void;
    enable(): void;
  }
}

interface RichTextEditorInstance extends RichTextEditorHandle {
  editorView: EditorView;
  enterFullScreen: () => void;
  exitFullScreen: () => void;
  nuke: () => void;
  reRender: () => void;
}

const getEditorIdFromElement = (element: Element): string => {
  const match = element.id.match(/\d+/);
  if (!match) throw new Error('Editor container missing numeric id');
  return match[0];
};

interface TogglePreferenceResponse {
  newValue: string;
}

// ProseMirror provides no native way to enable/disable the editor, so
// we add it here
EditorView.prototype.disable = function () {
  let editorElement = this.dom;
  $(editorElement).removeAttr('contenteditable').addClass('ProseMirror-disabled');
  $(editorElement).prev('.ProseMirror-menubar').addClass('ProseMirror-menubar-disabled');
};

EditorView.prototype.enable = function () {
  let editorElement = this.dom;
  $(editorElement).attr('contenteditable', 'true').removeClass('ProseMirror-disabled');
  $(editorElement).prev('.ProseMirror-menubar').removeClass('ProseMirror-menubar-disabled');
};

// We can have multiple RTEs on a page, and we keep generating new instances.
// The page-level counter keeps track of them. Access it only via its
// .current property.
const rteCounter = {
  _counter: 0,
  increase(): void {
    this._counter++;
  },
  get current(): number {
    return this._counter;
  },
  set current(_c: number) {
    throw new Error('Counter should only be increase()d or accessed.');
  },
};

// Active view instances and associated information. Uses numbers as keys
// but not an array to ensure consistent access even if instances are removed.
const rtes: Record<string, RichTextEditorInstance> = {};

// Export for access to other parts of the application, if available
libreviews.activeRTEs = rtes;

// We keep track of the RTE's caret and scroll position, but only if the
// markdown representation hasn't been changed.
$('textarea[data-markdown]').on('change', function (this: HTMLTextAreaElement) {
  $(this)
    .removeAttr('data-rte-sel-start')
    .removeAttr('data-rte-sel-end')
    .removeAttr('data-rte-scroll-y');
});

// Switch to the RTE
const ENABLE_RTE_SELECTOR = '[data-enable-rte]';

$(ENABLE_RTE_SELECTOR).conditionalSwitcherClick(function enableRTE(this: HTMLElement) {
  const $textarea = $(this).parent().prev('textarea') as JQuery<HTMLTextAreaElement>;
  if ($textarea.length === 0) return;

  const selStartAttr = $textarea.attr('data-rte-sel-start');
  const selEndAttr = $textarea.attr('data-rte-sel-end');
  const scrollYAttr = $textarea.attr('data-rte-scroll-y');

  const selStart = selStartAttr !== undefined ? Number(selStartAttr) : undefined;
  const selEnd = selEndAttr !== undefined ? Number(selEndAttr) : undefined;
  const scrollY = scrollYAttr !== undefined ? Number(scrollYAttr) : undefined;

  $textarea.hide();

  // Do the heavy lifting of creating a new RTE instance
  const $rteContainer = renderRTE($textarea);
  const $contentEditable = $rteContainer.find('[contenteditable="true"]') as JQuery<HTMLElement>;
  const editorID = getEditorIdFromElement($rteContainer[0]);

  if (selStart !== undefined && selEnd !== undefined) {
    const selectionRange: SavedSelectionRange = { start: selStart, end: selEnd };
    restoreSelection($contentEditable[0] as HTMLElement, selectionRange);
  }

  if (scrollY !== undefined) $contentEditable.scrollTop(scrollY);

  rtes[editorID]?.editorView.focus();

  // Show pin for persisting RTE settings
  $(this).parent().find('.switcher-pin').toggleClass('hidden', false);
});

// Switch back to markdown
const ENABLE_MARKDOWN_SELECTOR = '[data-enable-markdown]';

$(ENABLE_MARKDOWN_SELECTOR).conditionalSwitcherClick(function enableMarkdown(
  this: HTMLElement,
  event: JQuery.TriggeredEvent<HTMLElement>
) {
  const $rteContainer = $(this).parent().prev('.rte-container');
  const $textarea = $rteContainer.prev('textarea') as JQuery<HTMLTextAreaElement>;
  const $contentEditable = $rteContainer.find('[contenteditable=\"true\"]') as JQuery<HTMLElement>;
  const editorID = $rteContainer[0] ? getEditorIdFromElement($rteContainer[0]) : undefined;

  if (!editorID) return;

  // .detail contains number of clicks. If 0, user likely got here via
  // accesskey, so the blur() event never fired.
  const detail = (event.originalEvent as MouseEvent | undefined)?.detail ?? 1;
  if (detail === 0) {
    const rteInstance = rtes[editorID];
    if (rteInstance) {
      updateRTESelectionData($textarea, $contentEditable);
      updateTextarea($textarea, $contentEditable, rteInstance.editorView);
    }
  }

  // Delete the old RTE and all event handlers
  rtes[editorID]?.nuke();

  $textarea.show();
  const textareaElement = $textarea[0];
  if (textareaElement && textareaElement.hasAttribute('data-reset-textarea')) {
    $textarea.removeAttr('data-reset-textarea');
    textareaElement.setSelectionRange(0, 0);
  }

  // Hide pin for persisting RTE settings
  $(this).parent().find('.switcher-pin').toggleClass('hidden', true);
  $textarea.trigger('focus');
});

// Let users toggle preference for the RTE using a "sticky" pin next to the
// RTE control
const togglePreferenceSelector = '.switcher-pin[data-toggle-rte-preference]';

$(togglePreferenceSelector).on('click', function (this: HTMLElement) {
  const $pin = $(this);
  const spin = () =>
    $pin.removeClass('fa-thumb-tack').addClass('fa-spinner fa-spin switcher-working');
  const unspin = () =>
    $pin.removeClass('fa-spinner fa-spin switcher-working').addClass('fa-thumb-tack');

  let done = false;
  setTimeout(() => {
    if (!done) spin();
  }, 100);
  $.ajax({
    type: 'POST',
    url: `/api/actions/toggle-preference/`,
    data: JSON.stringify({
      preferenceName: 'prefersRichTextEditor',
    }),
    contentType: 'application/json',
    dataType: 'json',
  })
    .done((res: TogglePreferenceResponse) => {
      done = true;
      unspin();
      const { newValue } = res;

      if (newValue === 'true')
        // Because we may have multiple editors on a page, all pins need to be restyled
        $(togglePreferenceSelector)
          .removeClass('switcher-unpinned')
          .addClass('switcher-pinned')
          .attr('title', msg('forget rte preference'));
      else
        $(togglePreferenceSelector)
          .removeClass('switcher-pinned')
          .addClass('switcher-unpinned')
          .attr('title', msg('remember rte preference'));
    })
    .fail(() => {
      done = true;
      unspin();
      $('#generic-action-error').removeClass('hidden');
    });
});

// Switch all RTEs on if this is the user's preference. The switcher controls
// are already rendered server-side to be in RTE state.
if (window.config.userPrefersRichTextEditor) {
  $('textarea[data-markdown]').each(function (this: HTMLTextAreaElement) {
    const $textarea = $(this) as JQuery<HTMLTextAreaElement>;
    $textarea.hide();
    renderRTE($textarea);
  });
}

// Create a new RTE (ProseMirror) instance and add it to the DOM; register
// relevant event handlers.
function renderRTE($textarea: JQuery<HTMLTextAreaElement>): JQuery<HTMLDivElement> {
  // Local copy for this instance; only access count if you want to increase
  const myNumericId = rteCounter.current;
  const myID = String(myNumericId);

  const $rteContainer = $(`<div id="pm-edit-${myID}" class="rte-container"></div>`).insertAfter(
    $textarea
  ) as JQuery<HTMLDivElement>;

  const menuObj = buildMenuItems(markdownSchema);
  const initialContent = String($textarea.val() ?? '');
  const state = EditorState.create({
    doc: markdownParser.parse(initialContent),
    plugins: [
      buildInputRules(markdownSchema),
      keymap(getExtendedKeymap(markdownSchema, menuObj.items)),
      keymap(baseKeymap),
      history(),
      dropCursor(),
      menuBar({
        floating: false,
        content: menuObj.menu,
      }),
    ],
  });

  const containerElement = $rteContainer[0];
  if (!containerElement) throw new Error('Failed to create RTE container');

  const editorView = new EditorView(containerElement, {
    state,
  });

  const instance: RichTextEditorInstance = {
    editorView,
    enterFullScreen: () => {},
    exitFullScreen: () => {},
    nuke: () => {},
    reRender: () => {},
  };

  rtes[myID] = instance;

  // Show any help for textarea when focusing on RTE as well
  const textareaElement = $textarea[0];
  const textareaID = textareaElement?.id;
  if (textareaID && $(`[data-help-for="${textareaID}"]`).length) {
    $(editorView.dom).attr('data-acts-as', textareaID);
    addHelpListeners($(editorView.dom));
  }
  addCustomFeatures({ $rteContainer, instance, $textarea, instanceId: myID });

  rteCounter.increase();
  return $rteContainer;
}

// Adds the following:
// - Full screen editing
// - Automatic sizing of control to match textarea
// - Helpers to nuke/re-render RTE
// - Event handler to update markdown textarea from RTE
// - Event handler to track selection data within RTE even if mode is switched
function addCustomFeatures({
  $rteContainer,
  $textarea,
  instance,
  instanceId,
}: {
  $rteContainer: JQuery<HTMLDivElement>;
  $textarea: JQuery<HTMLTextAreaElement>;
  instance: RichTextEditorInstance;
  instanceId: string;
}): void {
  const $ce = $rteContainer.find('[contenteditable="true"]') as JQuery<HTMLElement>;

  // Style whole container (incl. menu bar etc.) like all inputs
  const addFocusStyle = () => $rteContainer.addClass('rte-focused');
  const removeFocusStyle = () => $rteContainer.removeClass('rte-focused');
  $ce.on('focus', addFocusStyle);
  $ce.on('focusout', removeFocusStyle);

  const getTextareaHeight = (): number => parseInt($textarea.css('height') || '0', 10) || 0;
  const getMenuHeight = (): number =>
    parseInt($rteContainer.find('.ProseMirror-menubar').css('height') || '41', 10) || 41;

  // Adjust height to match textarea
  const setRTEHeight = () => {
    const textareaHeight = getTextareaHeight();
    if (textareaHeight) $rteContainer.css('height', `${textareaHeight}px`);
    else $rteContainer.css('height', '10em');
    const rteHeight = textareaHeight - (getMenuHeight() + 2);
    if (rteHeight > 0) $ce.css('height', `${rteHeight}px`);
  };
  setRTEHeight();

  // Adjust height to full window
  const setRTEHeightFullScreen = () => {
    $rteContainer.addClass('rte-container-full-screen');
    $rteContainer.find('.ProseMirror,.ProseMirror-menubar').addClass('ProseMirror-full-screen');
    const rteHeight =
      (parseInt($rteContainer.css('height') || '0', 10) || 0) - (getMenuHeight() + 2);
    if (rteHeight > 0) $ce.css('height', `${rteHeight}px`);
  };

  // Helper to use full available window (or full screen if enabled) for editor
  instance.enterFullScreen = () => {
    $(window).off('resize', setRTEHeight);
    $(window).on('resize', setRTEHeightFullScreen);
    setRTEHeightFullScreen();
    $ce.off('focus', addFocusStyle);
    $ce.off('focusout', removeFocusStyle);
    removeFocusStyle();
    instance.editorView.focus();
  };

  // Back to normal
  instance.exitFullScreen = () => {
    $(window).off('resize', setRTEHeightFullScreen);
    $(window).on('resize', setRTEHeight);
    $rteContainer.removeClass('rte-container-full-screen');
    $rteContainer.find('.ProseMirror,.ProseMirror-menubar').removeClass('ProseMirror-full-screen');
    setRTEHeight();
    $ce.on('focus', addFocusStyle);
    $ce.on('focusout', removeFocusStyle);
    addFocusStyle();
    instance.editorView.focus();
  };

  // Menu can wrap, so keep an eye on the height
  $(window).on('resize', setRTEHeight);

  $ce.on('blur', function () {
    const $current = $(this) as JQuery<HTMLElement>;
    updateRTESelectionData($textarea, $current);
    // Re-generating the markdown on blur is a performance compromise; we may want
    // to add more triggers if this is insufficient.
    updateTextarea($textarea, $current, instance.editorView);
  });

  // Try to ensure the textarea is up-to-date before any "Save draft"
  // functionality kicks in
  const updateOnUnload = () => updateTextarea($textarea, $ce, instance.editorView);

  $(window).on('beforeunload', updateOnUnload);

  // Full remove this control and all associated event handlers
  instance.nuke = function () {
    $ce.off();
    $(window).off('resize', setRTEHeight);
    $(window).off('resize', setRTEHeightFullScreen);
    $(window).off('beforeunload', updateOnUnload);
    instance.editorView.destroy();
    delete rtes[instanceId];
    $rteContainer.remove();
  };

  // Helper for external access to re-generate RTE
  instance.reRender = function () {
    instance.nuke();
    renderRTE($textarea);
  };
}

// Serialize RTE content into Markdown and update textarea
function updateTextarea(
  $textarea: JQuery<HTMLTextAreaElement>,
  $ce: JQuery<HTMLElement>,
  editorView: EditorView
): void {
  const markdown = markdownSerializer.serialize(editorView.state.doc);
  const currentValue = String($textarea.val() ?? '');
  if (markdown !== currentValue) {
    $textarea.val(markdown);
    $textarea.trigger('keyup').trigger('change');
    // Make a note that cursor needs to be reset. This must happen after
    // the textarea's visibility is restored to work correctly in Firefox.
    $textarea.attr('data-reset-textarea', '');
  }
}

// We want to be able to preserve the user's place in the document unless
// they've changed it. To do so, we stash the current RTE selection in the
// textarea, since we create a new RTE instance every time the user switches
// between editing environments.
function updateRTESelectionData(
  $textarea: JQuery<HTMLTextAreaElement>,
  $ce: JQuery<HTMLElement>
): void {
  if (saveSelection) {
    const selectionElement = $ce[0] as HTMLElement;
    const sel = saveSelection(selectionElement);
    const scrollY = $ce.scrollTop();
    if (typeof sel === 'object' && typeof sel.start === 'number' && typeof sel.end === 'number') {
      $textarea.attr('data-rte-sel-start', String(sel.start));
      $textarea.attr('data-rte-sel-end', String(sel.end));
    }
    $textarea.attr('data-rte-scroll-y', String(scrollY));
  }
}
