/* global $, config */
import {
  wrapItem,
  blockTypeItem,
  Dropdown,
  DropdownSubmenu,
  joinUpItem,
  liftItem,
  undoItem,
  redoItem,
  icons,
  MenuItem
} from 'prosemirror-menu';

import unescapeHTML from 'unescape-html';
import libreviews, { msg } from './libreviews.js';

// Load proper translations for built-in items
undoItem.spec.title = msg('undo');
redoItem.spec.title = msg('redo');
joinUpItem.spec.title = msg('join with item above');
liftItem.spec.title = msg('decrease item indentation');

import { NodeSelection, TextSelection } from 'prosemirror-state';
import { toggleMark, wrapIn } from 'prosemirror-commands';
import { wrapInList } from 'prosemirror-schema-list';
import { TextField, openPrompt } from './editor-prompt.js';
import { uploadModal } from './upload-modal.js';
import { guessMediaType } from 'markdown-it-html5-media';

// Helpers to create specific types of items

function canInsert(state, nodeType, attrs) {
  let $from = state.selection.$from;
  for (let d = $from.depth; d >= 0; d--) {
    let index = $from.index(d);
    if ($from.node(d).canReplaceWith(index, index, nodeType, attrs))
      return true;
  }
  return false;
}

function insertMediaItem(nodeTypes, schema) {
  return new MenuItem({
    title: msg('insert media help'),
    label: msg('insert media'),
    select(state) {
      return canInsert(state, nodeTypes.image);
    },
    run(state, _dispatch, view) {
      let { from, to } = state.selection,
        attrs = null,
        showCaptionField = true;

      // Extract attributes from any media selection. We apply ALT text from
      // images to video/audio descriptions and vice versa
      if (state.selection instanceof NodeSelection) {
        switch (state.selection.node.type.name) {
          case 'image':
            attrs = {
              src: state.selection.node.attrs.src,
              alt: state.selection.node.attrs.alt ||
                state.selection.node.attrs.description || null
            };
            break;
          case 'video':
          case 'audio':
            attrs = {
              src: state.selection.node.attrs.src,
              description: state.selection.node.attrs.description ||
                state.selection.node.attrs.alt || null
            };
            break;
          default:
            // No default
        }
        showCaptionField = false;
      }
      const fields = {};

      fields.src = new TextField({ label: msg('media url'), required: true, value: attrs && attrs.src });

      if (showCaptionField)
        fields.caption = new TextField({
          label: msg('caption label'),
        });

      fields.alt = new TextField({
        label: msg('media alt text'),
        value: attrs ? attrs.alt || attrs.description : state.doc.textBetween(from, to, " ")
      });

      openPrompt({
        view,
        fields,
        title: msg('insert media dialog title'),
        callback(attrs) {
          const nodeType = guessMediaType(attrs.src);
          // <video>/<audio> tags do not support ALT; the text is rendered
          // as inner HTML alongside the fallback message.
          if (['video', 'audio'].includes(nodeType)) {
            attrs.description = attrs.alt;
            Reflect.deleteProperty(attrs, 'alt');
          }
          let tr = view.state.tr.replaceSelectionWith(nodeTypes[nodeType].createAndFill(attrs));
          if (attrs.caption && attrs.caption.length)
            tr = addCaption({ description: attrs.caption + '\n', schema, state: view.state, transaction: tr });
          view.dispatch(tr);
          view.focus();
        }
      });
    }
  });
}

function addCaption({ description, schema, state, transaction }) {
  const br = schema.nodes.hard_break.create(),
    descriptionNode = schema.text(description,
    schema.marks.strong.create()),
    pos = state.selection.$anchor.pos;
  return transaction
  .insert(pos + 1, br)
  .insert(pos + 2, descriptionNode);
}

function horizontalRuleItem(hr) {

  return new MenuItem({
    title: msg('insert horizontal rule help', { accessKey: '_' }),
    label: msg('insert horizontal rule'),
    select(state) {
      return canInsert(state, hr);
    },
    run(state, dispatch) {
      dispatch(state.tr.replaceSelectionWith(hr.create()));
    }
  });
}


function cmdItem(cmd, options) {
  let passedOptions = {
    label: options.title,
    run: cmd,
    select(state) {
      return cmd(state);
    }
  };
  for (let prop in options)
    passedOptions[prop] = options[prop];
  return new MenuItem(passedOptions);
}

function markActive(state, type) {
  let { from, $from, to, empty } = state.selection;
  if (empty)
    return type.isInSet(state.storedMarks || $from.marks());
  else
    return state.doc.rangeHasMark(from, to, type);
}

function markItem(markType, options) {
  let passedOptions = {
    active(state) {
      return markActive(state, markType);
    }
  };
  for (let prop in options)
    passedOptions[prop] = options[prop];
  return cmdItem(toggleMark(markType), passedOptions);
}

function fullScreenItem() {
  return new MenuItem({
    title: msg('full screen mode', { accessKey: 'u' }),
    icon: { dom: $('<span class="fa fa-arrows-alt baselined-icon"></span>')[0] },
    active() {
      return this.enabled || false;
    },
    run(state, _dispatch, view) {
      let $rteContainer = $(view.dom).closest('.rte-container');
      let id = Number($rteContainer[0].id.match(/\d+/)[0]);
      if (!this.enabled) {
        libreviews.activeRTEs[id].enterFullScreen();
        this.enabled = true;
      } else {
        libreviews.activeRTEs[id].exitFullScreen();
        this.enabled = false;
      }
      view.updateState(state);
    }
  });
}

function uploadModalItem(mediaNodes, schema) {
  return new MenuItem({
    title: msg('upload and insert media'),
    icon: { dom: $('<span class="fa fa-cloud-upload baselined-icon"><span>')[0] },
    active() {
      return false;
    },
    run(state, dispatch, view) {
      // For some forms, we submit uploaded file IDs so they can be processed
      // server-side
      const $form = $(view.dom).closest('form[data-submit-uploaded-files]');
      uploadModal(uploads => {
        const upload = uploads[0];
        const attrs = {
          src: `/static/uploads/${encodeURIComponent(upload.uploadedFileName)}`
        };
        const nodeType = guessMediaType(attrs.src);
        const description = generateDescriptionFromUpload(upload);
        let tr = state.tr
          .replaceSelectionWith(mediaNodes[nodeType].createAndFill(attrs));
        tr = addCaption({ description, schema, state, transaction: tr });
        dispatch(tr);

        if ($form.length) {
          $form.append(`<input type="hidden" ` +
            ` name="uploaded-file-${upload.fileID}" value="1">`);
          if ($form.find('#social-media-image-select').length) {
            let summarizedDesc = upload.description[config.language].substr(0, 80);
            if (upload.description[config.language].length > 80)
              summarizedDesc += '...';
            $('#social-media-image-select').append(`<option value="${upload.fileID}">` +
            `${upload.uploadedFileName}: ${summarizedDesc}` +
            `</option>`);
          }
        }
        view.focus();
      });
    }
  });
}

function generateDescriptionFromUpload(upload) {
  // API returns escaped HTML; editor will re-escape it
  const description = unescapeHTML(upload.description[config.language]);
  const creator = upload.creator && upload.creator[config.language];
  let license;
  switch (upload.license) {
    case 'fair-use':
      license = msg('fair use in caption');
      break;
    case 'cc-0':
      license = msg('public domain in caption');
      break;
    default:
      license = msg('license in caption', {
        stringParam: msg(`${upload.license} short`)
      });
  }

  let rights;
  if (!creator) // Own work
    rights = msg('rights in caption, own work', { stringParam: license });
  else
    rights = msg('rights in caption, someone else\'s work', {
      stringParams: [creator, license]
    });
  const caption = msg('caption', { stringParams: [description, rights] });
  // Final newline is important to ensure resulting markdown is parsed correctly
  return caption + '\n';
}

function formatCustomWarningItem(nodeType) {
  return new MenuItem({
    title: msg('format as custom warning help'),
    label: msg('format as custom warning'),
    run(state, dispatch, view) {
      let prompt = {
        view,
        title: msg('format as custom warning dialog title'),
        fields: {
          message: new TextField({
            label: msg('custom warning text'),
            required: true
          })
        },
        callback(attrs) {
          // Used to translate node back into markdown
          attrs.markup = `warning ${attrs.message}`;
          wrapIn(nodeType, attrs)(state, dispatch);
          view.focus();
        }
      };
      openPrompt(prompt);
    },
    select(state) {
      return wrapIn(nodeType)(state);
    }
  });
}

function linkItem(schema) {
  return new MenuItem({
    title: msg('add or remove link', { accessKey: 'k' }),
    icon: icons.link,
    active(state) {
      return markActive(state, schema.marks.link);
    },
    run(state, dispatch, view) {
      if (markActive(state, schema.marks.link)) {
        toggleMark(schema.marks.link)(state, dispatch);
        return true;
      }
      const required = true;
      const fields = {
        href: new TextField({
          label: msg('web address'),
          required,
          clean: val => !/^https?:\/\//i.test(val) ? 'http://' + val : val
        })
      };
      // User has not selected any text, so needs to provide it via dialog
      if (view.state.selection.empty)
        fields.linkText = new TextField({
          label: msg('link text'),
          required,
          clean: val => val.trim()
        });
      openPrompt({
        view,
        title: msg('add link dialog title'),
        fields,
        callback(attrs) {
          if (!attrs.linkText) {
            // Transform selected text into link
            toggleMark(schema.marks.link, attrs)(view.state, view.dispatch);
            // Advance cursor to end of selection (not necessarily head,
            // depending on selection direction)
            let rightmost = view.state.selection.$anchor.pos > view.state.selection.$head.pos ?
              view.state.selection.$anchor : view.state.selection.$head;
            view.dispatch(view.state.tr.setSelection(TextSelection.between(rightmost, rightmost)));
            // Disable link mark so user can now type normally again
            toggleMark(schema.marks.link, attrs)(view.state, view.dispatch);
          } else {
            view.dispatch(
              view.state.tr
              .replaceSelectionWith(schema.text(attrs.linkText))
              .addMark(view.state.selection.$from.pos,
                view.state.selection.$from.pos + attrs.linkText.length,
                schema.marks.link.create({ href: attrs.href }))
            );
          }
          view.focus();
        }
      });
    }
  });
}

function wrapListItem(nodeType, options) {
  return cmdItem(wrapInList(nodeType, options.attrs), options);
}

function headingItems(nodeType) {
  const headingItems = [];
  for (let i = 1; i <= 6; i++)
    headingItems[i - 1] = blockTypeItem(nodeType, {
      title: msg('format as level heading help', { accessKey: String(i), numberParam: i }),
      label: msg('format as level heading', { numberParam: i }),
      attrs: { level: i }
    });
  return headingItems;
}

/**
 * Build a menu for nodes and marks supported in the markdown schema.
 *
 * @param {Schema} schema
 *  the markdown schema
 * @returns {Object}
 *  the generated menu and all its items
 */
function buildMenuItems(schema) {
  const mediaNodes = {
    image: schema.nodes.image,
    video: schema.nodes.video,
    audio: schema.nodes.audio
  };

  const items = {
    toggleStrong: markItem(schema.marks.strong, { title: msg('toggle bold', { accessKey: 'b' }), icon: icons.strong }),
    toggleEm: markItem(schema.marks.em, { title: msg('toggle italic', { accessKey: 'i' }), icon: icons.em }),
    toggleCode: markItem(schema.marks.code, { title: msg('toggle code', { accessKey: '`' }), icon: icons.code }),
    toggleLink: linkItem(schema),
    insertMedia: insertMediaItem(mediaNodes, schema),
    insertHorizontalRule: horizontalRuleItem(schema.nodes.horizontal_rule),
    wrapBulletList: wrapListItem(schema.nodes.bullet_list, {
      title: msg('format as bullet list', { accessKey: '8' }),
      icon: icons.bulletList
    }),
    wrapOrderedList: wrapListItem(schema.nodes.ordered_list, {
      title: msg('format as numbered list', { accessKey: '9' }),
      icon: icons.orderedList
    }),
    wrapBlockQuote: wrapItem(schema.nodes.blockquote, {
      title: msg('format as quote', { accessKey: '>' }),
      icon: icons.blockquote
    }),
    makeParagraph: blockTypeItem(schema.nodes.paragraph, {
      title: msg('format as paragraph help', { accessKey: '0' }),
      label: msg('format as paragraph')
    }),
    makeCodeBlock: blockTypeItem(schema.nodes.code_block, {
      title: msg('format as code block help'),
      label: msg('format as code block')
    }),
    formatSpoilerWarning: wrapItem(schema.nodes.container_warning, {
      title: msg('format as spoiler help'),
      label: msg('format as spoiler'),
      attrs: { markup: 'spoiler', message: msg('spoiler warning') }
    }),
    formatNSFWWarning: wrapItem(schema.nodes.container_warning, {
      title: msg('format as nsfw help'),
      label: msg('format as nsfw'),
      attrs: { markup: 'nsfw', message: msg('nsfw warning') }
    }),
    formatCustomWarning: formatCustomWarningItem(schema.nodes.container_warning),
    makeHeading: headingItems(schema.nodes.heading),
    fullScreen: fullScreenItem(),
    undo: undoItem,
    redo: redoItem,
    joinUp: joinUpItem,
    lift: liftItem
  };

  // Only trusted users can upload files directly from within the RTE.
  if (config.isTrusted)
    items.upload = uploadModalItem(mediaNodes, schema);

  const insertDropdown = new Dropdown([items.insertMedia, items.insertHorizontalRule], {
    label: msg('insert'),
    title: msg('insert help')
  });

  const headingSubmenu = new DropdownSubmenu([...items.makeHeading], { label: msg('format as heading') });

  const typeDropdown = new Dropdown(
    [
      items.makeParagraph, items.makeCodeBlock, items.formatSpoilerWarning,
      items.formatNSFWWarning, items.formatCustomWarning, headingSubmenu
    ], {
      label: msg('format block'),
      title: msg('format block help')
    });

  // Create final menu structure. In the rendered menu, there is a separator
  // symbol between each array

  const mediaOptions = [insertDropdown];

  // Only trusted users can upload files directly via the RTE.
  if (config.isTrusted)
    mediaOptions.push(items.upload);

  const menu = [
    [items.toggleStrong, items.toggleEm, items.toggleCode, items.toggleLink],
    mediaOptions,
    [typeDropdown, items.wrapBulletList, items.wrapOrderedList, items.wrapBlockQuote, items.joinUp, items.lift],
    [items.undo, items.redo],
    [items.fullScreen]
  ];

  // We expose the items object so it can be used to externally trigger a menu
  // function, e.g., via a keyboard shortcut
  return { menu, items };
}

export { buildMenuItems };
