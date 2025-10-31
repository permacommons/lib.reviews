/* eslint prefer-reflect: "off" */

import 'prosemirror-view/style/prosemirror.css';
import 'prosemirror-menu/style/menu.css';
import './styles/editor-overrides.css';

import $ from './lib/jquery.mjs';

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
import { buildInputRules } from './editor-inputrules.mjs';

// Custom keymap
import { getExtendedKeymap } from './editor-extended-keymap.mjs';

// Custom menu
import { buildMenuItems } from './editor-menu.mjs';

// For tracking contentEditable selection
import { saveSelection, restoreSelection } from './editor-selection.mjs';

// For parsing, serializing and tokenizing markdown including our custom
// markup for spoiler/NSFW warnings
import { markdownParser, markdownSerializer, markdownSchema } from './editor-markdown.mjs';
import libreviews, { addHelpListeners, msg } from './libreviews.mjs';

// ProseMirror provides no native way to enable/disable the editor, so
// we add it here
EditorView.prototype.disable = function() {
  let editorElement = this.dom;
  $(editorElement)
    .removeAttr('contenteditable')
    .addClass('ProseMirror-disabled');
  $(editorElement)
    .prev('.ProseMirror-menubar')
    .addClass('ProseMirror-menubar-disabled');
};

EditorView.prototype.enable = function() {
  let editorElement = this.dom;
  $(editorElement)
    .attr('contenteditable', true)
    .removeClass('ProseMirror-disabled');
  $(editorElement)
    .prev('.ProseMirror-menubar')
    .removeClass('ProseMirror-menubar-disabled');
};

// We can have multiple RTEs on a page, and we keep generating new instances.
// The page-level counter keeps track of them. Access it only via its
// .current property.
const rteCounter = {
  _counter: 0,
  increase() {
    this._counter++;
  },
  get current() {
    return this._counter;
  },
  set current(c) {
    throw new Error('Counter should only be increase()d or accessed.');
  }
};

// Active view instances and associated information. Uses numbers as keys
// but not an array to ensure consistent access even if instances are removed.
let rtes = {};

// Export for access to other parts of the application, if available
libreviews.activeRTEs = rtes;

// We keep track of the RTE's caret and scroll position, but only if the
// markdown representation hasn't been changed.
$('textarea[data-markdown]').change(function() {
  $(this)
    .removeAttr('data-rte-sel-start')
    .removeAttr('data-rte-sel-end')
    .removeAttr('data-rte-scroll-y');
});

// Switch to the RTE
$('[data-enable-rte]').conditionalSwitcherClick(function enableRTE() {

  let $textarea = $(this).parent().prev(),
    selStart = $textarea.attr('data-rte-sel-start'),
    selEnd = $textarea.attr('data-rte-sel-end'),
    scrollY = $textarea.attr('data-rte-scroll-y');

  $textarea.hide();

  // Do the heavy lifting of creating a new RTE instance
  let $rteContainer = renderRTE($textarea),
    $contentEditable = $rteContainer.find('[contenteditable="true"]'),
    editorID = Number($rteContainer[0].id.match(/\d+/)[0]);

  if (selStart !== undefined && selEnd !== undefined)
    restoreSelection($contentEditable[0], { start: selStart, end: selEnd });

  if (scrollY !== undefined)
    $contentEditable.scrollTop(scrollY);

  rtes[editorID].editorView.focus();

  // Show pin for persisting RTE settings
  $(this)
    .parent()
    .find('.switcher-pin')
    .toggleClass('hidden', false);

});

// Switch back to markdown
$('[data-enable-markdown]').conditionalSwitcherClick(function enableMarkdown(event) {

  let $rteContainer = $(this).parent().prev(),
    $textarea = $rteContainer.prev(),
    $contentEditable = $rteContainer.find('[contenteditable="true"]'),
    editorID = $rteContainer[0].id.match(/\d+/)[0];

  // .detail contains number of clicks. If 0, user likely got here via
  // accesskey, so the blur() event never fired.
  if (event.originalEvent.detail === 0) {
    updateRTESelectionData($textarea, $contentEditable);
    updateTextarea($textarea, $contentEditable, rtes[editorID].editorView);
  }

  // Delete the old RTE and all event handlers
  rtes[editorID].nuke();

  $textarea.show();
  if ($textarea[0].hasAttribute('data-reset-textarea')) {
    $textarea.removeAttr('data-reset-textarea');
    $textarea[0].setSelectionRange(0, 0);
  }

  // Hide pin for persisting RTE settings
  $(this)
    .parent()
    .find('.switcher-pin')
    .toggleClass('hidden', true);
  $textarea.focus();
});

// Let users toggle preference for the RTE using a "sticky" pin next to the
// RTE control
$('.switcher-pin[data-toggle-rte-preference]').click(function() {
  let $pin = $(this);
  let spin = () => $pin
    .removeClass('fa-thumb-tack')
    .addClass('fa-spinner fa-spin switcher-working');
  let unspin = () => $pin
    .removeClass('fa-spinner fa-spin switcher-working')
    .addClass('fa-thumb-tack');

  let done = false;
  setTimeout(() => {
    if (!done) spin();
  }, 100);
  $.ajax({
      type: 'POST',
      url: `/api/actions/toggle-preference/`,
      data: JSON.stringify({
        preferenceName: 'prefersRichTextEditor'
      }),
      contentType: 'application/json',
      dataType: 'json'
    })
    .done(res => {
      done = true;
      unspin();
      let { newValue } = res;

      if (newValue === 'true')
        // Because we may have multiple editors on a page, all pins need to be restyled
        $('.switcher-pin[data-toggle-rte-preference]')
          .removeClass('switcher-unpinned')
          .addClass('switcher-pinned')
          .attr('title', msg('forget rte preference'));
      else
        $('.switcher-pin[data-toggle-rte-preference]')
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
  $('textarea[data-markdown]').each(function() {
    let $textarea = $(this);
    $textarea.hide();
    renderRTE($textarea);
  });
}

// Create a new RTE (ProseMirror) instance and add it to the DOM; register
// relevant event handlers.
function renderRTE($textarea) {

  // Local copy for this instance; only access count if you want to increase
  let myID = rteCounter.current;

  let $rteContainer = $(`<div id="pm-edit-${myID}" class="rte-container"></div>`)
    .insertAfter($textarea);

  const menuObj = buildMenuItems(markdownSchema);
  const state = EditorState.create({
    doc: markdownParser.parse($textarea.val()),
    plugins: [
      buildInputRules(markdownSchema),
      keymap(getExtendedKeymap(markdownSchema, menuObj.items)),
      keymap(baseKeymap),
      history(),
      dropCursor(),
      menuBar({
        floating: false,
        content: menuObj.menu
      })
    ]
  });

  let editorView = new EditorView($(`#pm-edit-${myID}`)[0], {
    state
  });

  rtes[myID] = { editorView };

  // Show any help for textarea when focusing on RTE as well
  const textareaID = $textarea[0].id;
  if ($(`[data-help-for="${textareaID}"]`).length) {
    $(editorView.dom).attr('data-acts-as', textareaID);
    addHelpListeners($(editorView.dom));
  }
  addCustomFeatures({ $rteContainer, myID, $textarea });

  rteCounter.increase();
  return $rteContainer;
}

// Adds the following:
// - Full screen editing
// - Automatic sizing of control to match textarea
// - Helpers to nuke/re-render RTE
// - Event handler to update markdown textarea from RTE
// - Event handler to track selection data within RTE even if mode is switched
function addCustomFeatures(spec) {
  const { $rteContainer, $textarea, myID } = spec;
  const $ce = $rteContainer.find('[contenteditable="true"]');

  // Style whole container (incl. menu bar etc.) like all inputs
  const addFocusStyle = () => $rteContainer.addClass('rte-focused');
  const removeFocusStyle = () => $rteContainer.removeClass('rte-focused');
  $ce.focus(addFocusStyle);
  $ce.focusout(removeFocusStyle);

  // Adjust height to match textarea
  const setRTEHeight = () => {
    let textareaHeight = $textarea.css('height');
    if (textareaHeight)
      $rteContainer.css('height', textareaHeight);
    else
      $rteContainer.css('height', '10em');
    textareaHeight = parseInt($textarea.css('height'), 10);
    let menuHeight = parseInt($rteContainer.find('.ProseMirror-menubar').css('height'), 10) || 41;
    let rteHeight = textareaHeight - (menuHeight + 2);
    $ce.css('height', rteHeight + 'px');
  };
  setRTEHeight();

  // Adjust height to full window
  const setRTEHeightFullScreen = () => {
    $rteContainer.addClass('rte-container-full-screen');
    $rteContainer.find('.ProseMirror,.ProseMirror-menubar').addClass('ProseMirror-full-screen');
    let menuHeight = parseInt($rteContainer.find('.ProseMirror-menubar').css('height'), 10) || 41;
    let rteHeight = parseInt($rteContainer.css('height'), 10) - (menuHeight + 2);
    $ce.css('height', rteHeight + 'px');
  };

  // Helper to use full available window (or full screen if enabled) for editor
  rtes[myID].enterFullScreen = () => {
    $(window).off('resize', setRTEHeight);
    $(window).on('resize', setRTEHeightFullScreen);
    setRTEHeightFullScreen();
    $ce.off('focus', addFocusStyle);
    $ce.off('focusout', removeFocusStyle);
    removeFocusStyle();
    rtes[myID].editorView.focus();
  };

  // Back to normal
  rtes[myID].exitFullScreen = () => {
    $(window).off('resize', setRTEHeightFullScreen);
    $(window).on('resize', setRTEHeight);
    $rteContainer.removeClass('rte-container-full-screen');
    $rteContainer.find('.ProseMirror,.ProseMirror-menubar').removeClass('ProseMirror-full-screen');
    setRTEHeight();
    $ce.focus(addFocusStyle);
    $ce.focusout(removeFocusStyle);
    addFocusStyle();
    rtes[myID].editorView.focus();
  };

  // Menu can wrap, so keep an eye on the height
  $(window).resize(setRTEHeight);

  $ce.blur(function() {
    updateRTESelectionData($textarea, $(this));
    // Re-generating the markdown on blur is a performance compromise; we may want
    // to add more triggers if this is insufficient.
    updateTextarea($textarea, $(this), rtes[myID].editorView);
  });

  // Try to ensure the textarea is up-to-date before any "Save draft"
  // functionality kicks in
  const updateOnUnload = () => updateTextarea($textarea, $ce, rtes[myID].editorView);

  $(window).on('beforeunload', updateOnUnload);

  // Full remove this control and all associated event handlers
  rtes[myID].nuke = function() {
    $ce.off();
    $(window).off('resize', setRTEHeight);
    $(window).off('beforeunload', updateOnUnload);
    rtes[myID].editorView.destroy();
    delete rtes[myID];
    $rteContainer.remove();
  };

  // Helper for external access to re-generate RTE
  rtes[myID].reRender = function() {
    rtes[myID].nuke();
    renderRTE($textarea);
  };
}

// Serialize RTE content into Markdown and update textarea
function updateTextarea($textarea, $ce, editorView) {
  let markdown = markdownSerializer.serialize(editorView.state.doc);
  if (markdown !== $textarea.val()) {
    $textarea.val(markdown);
    $textarea
      .trigger('keyup')
      .trigger('change');
    // Make a note that cursor needs to be reset. This must happen after
    // the textarea's visibility is restored to work correctly in Firefox.
    $textarea.attr('data-reset-textarea', '');
  }
}

// We want to be able to preserve the user's place in the document unless
// they've changed it. To do so, we stash the current RTE selection in the
// textarea, since we create a new RTE instance every time the user switches
// between editing environments.
function updateRTESelectionData($textarea, $ce) {
  if (saveSelection) {
    let sel = saveSelection($ce[0]);
    let scrollY = $($ce[0]).scrollTop();
    if (typeof sel == 'object' && typeof sel.start == 'number' && typeof sel.end == 'number') {
      $textarea.attr('data-rte-sel-start', sel.start);
      $textarea.attr('data-rte-sel-end', sel.end);
    }
    $textarea.attr('data-rte-scroll-y', scrollY);
  }
}
