import { guessMediaType } from 'markdown-it-html5-media';
import { setBlockType, toggleMark, wrapIn } from 'prosemirror-commands';
import {
  blockTypeItem,
  Dropdown,
  DropdownSubmenu,
  icons,
  joinUpItem,
  liftItem,
  type MenuElement,
  MenuItem,
  redoItem,
  undoItem,
  wrapItem,
} from 'prosemirror-menu';
import type { Attrs, MarkType, NodeType, Schema } from 'prosemirror-model';
import { liftListItem, sinkListItem, splitListItem, wrapInList } from 'prosemirror-schema-list';
import {
  type Command,
  EditorState,
  NodeSelection,
  TextSelection,
  Transaction,
} from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';

import { decodeHTML } from 'entities';
import { openPrompt, type PromptSpec, TextField } from './editor-prompt.ts';
import $ from './lib/jquery.js';
import libreviews, { msg } from './libreviews.ts';
import { uploadModal } from './upload-modal.ts';

type MediaKind = 'image' | 'video' | 'audio';

interface MediaNodeTypes {
  image: NodeType;
  video: NodeType;
  audio: NodeType;
}

interface MediaAttributes extends Record<string, unknown> {
  src: string;
  alt?: string | null;
  description?: string | null;
  title?: string | null;
  caption?: string;
  markup?: string;
  message?: string;
}

interface UploadMetadata {
  uploadedFileName: string;
  fileID: string;
  description: Record<string, string>;
  license: string;
  creator?: Record<string, string> | null;
}

export interface ExtendedMenuItem extends MenuItem {
  spec: MenuItem['spec'] & {
    run: NonNullable<MenuItem['spec']['run']>;
    enabled?: boolean;
  };
}

export interface EditorMenuItems {
  toggleStrong: MenuItem;
  toggleEm: MenuItem;
  toggleCode: MenuItem;
  toggleLink: MenuItem;
  insertMedia: MenuItem;
  insertHorizontalRule: MenuItem;
  wrapBulletList: MenuItem;
  wrapOrderedList: MenuItem;
  wrapBlockQuote: MenuItem;
  makeParagraph: MenuItem;
  makeCodeBlock: MenuItem;
  formatSpoilerWarning: MenuItem;
  formatNSFWWarning: MenuItem;
  formatCustomWarning: MenuItem;
  makeHeading: MenuItem[];
  fullScreen: ExtendedMenuItem;
  undo: MenuItem;
  redo: MenuItem;
  joinUp: MenuItem;
  lift: MenuItem;
  upload?: MenuItem;
}

type MenuItemInit = Partial<MenuItem['spec']> & {
  title?: string | ((state: EditorState) => string);
  label?: string;
  icon?: MenuItem['spec']['icon'];
  attrs?: Attrs;
};

// Load proper translations for built-in items
undoItem.spec.title = msg('undo');
redoItem.spec.title = msg('redo');
joinUpItem.spec.title = msg('join with item above');
liftItem.spec.title = msg('decrease item indentation');

// Helpers to create specific types of items

function canInsert(state: EditorState, nodeType: NodeType): boolean {
  const $from = state.selection.$from;
  for (let depth = $from.depth; depth >= 0; depth--) {
    const index = $from.index(depth);
    if ($from.node(depth).canReplaceWith(index, index, nodeType)) return true;
  }
  return false;
}

function insertMediaItem(nodeTypes: MediaNodeTypes, schema: Schema): MenuItem {
  return new MenuItem({
    title: msg('insert media help'),
    label: msg('insert media'),
    select(state: EditorState) {
      return canInsert(state, nodeTypes.image);
    },
    run(
      state: EditorState,
      _dispatch: ((tr: Transaction) => void) | undefined,
      view?: EditorView | null
    ) {
      if (!view) return;
      const { from, to } = state.selection;
      let attrs: MediaAttributes | null = null;
      let showCaptionField = true;

      // Extract attributes from any media selection. We apply ALT text from
      // images to video/audio descriptions and vice versa
      if (state.selection instanceof NodeSelection) {
        switch (state.selection.node.type.name) {
          case 'image':
            attrs = {
              src: state.selection.node.attrs.src,
              alt: state.selection.node.attrs.alt || state.selection.node.attrs.description || null,
            };
            break;
          case 'video':
          case 'audio':
            attrs = {
              src: state.selection.node.attrs.src,
              description:
                state.selection.node.attrs.description || state.selection.node.attrs.alt || null,
            };
            break;
          default:
          // No default
        }
        showCaptionField = false;
      }
      const fields: Record<string, TextField> = {};

      fields.src = new TextField({
        label: msg('media url'),
        required: true,
        value: attrs?.src ?? undefined,
      });

      if (showCaptionField) {
        fields.caption = new TextField({
          label: msg('caption label'),
        });
      }

      fields.alt = new TextField({
        label: msg('media alt text'),
        value: attrs
          ? (attrs.alt ?? attrs.description ?? undefined)
          : state.doc.textBetween(from, to, ' '),
      });

      openPrompt({
        view,
        fields,
        title: msg('insert media dialog title'),
        callback(attrs) {
          const callbackAttrs = attrs as MediaAttributes;
          const nodeType = guessMediaType(callbackAttrs.src) as MediaKind;
          // <video>/<audio> tags do not support ALT; the text is rendered
          // as inner HTML alongside the fallback message.
          if (['video', 'audio'].includes(nodeType)) {
            callbackAttrs.description = callbackAttrs.alt;
            Reflect.deleteProperty(callbackAttrs, 'alt');
          }
          let tr = view.state.tr.replaceSelectionWith(
            nodeTypes[nodeType].createAndFill(callbackAttrs as Attrs)
          );
          if (callbackAttrs.caption && callbackAttrs.caption.length)
            tr = addCaption({
              description: callbackAttrs.caption + '\n',
              schema,
              state: view.state,
              transaction: tr,
            });
          view.dispatch(tr);
          view.focus();
        },
      });
    },
  });
}

function addCaption({
  description,
  schema,
  state,
  transaction,
}: {
  description: string;
  schema: Schema;
  state: EditorState;
  transaction: Transaction;
}): Transaction {
  const hardBreak = schema.nodes.hard_break;
  const strongMark = schema.marks.strong;

  if (!hardBreak || !strongMark) return transaction;

  const br = hardBreak.create();
  const descriptionNode = schema.text(description, [strongMark.create()]);
  const pos = state.selection.$anchor.pos;

  return transaction.insert(pos + 1, br).insert(pos + 2, descriptionNode);
}

function horizontalRuleItem(hr: NodeType): MenuItem {
  return new MenuItem({
    title: msg('insert horizontal rule help', { accessKey: '_' }),
    label: msg('insert horizontal rule'),
    select(state: EditorState) {
      return canInsert(state, hr);
    },
    run(state: EditorState, dispatch?: (tr: Transaction) => void) {
      if (dispatch) dispatch(state.tr.replaceSelectionWith(hr.create()));
    },
  });
}

function cmdItem(cmd: Command, options: MenuItemInit): MenuItem {
  const { attrs: _attrs, ...rest } = options;
  const baseLabel = typeof rest.label === 'string' ? rest.label : undefined;
  const titleLabel = typeof rest.title === 'string' ? rest.title : undefined;
  const label = baseLabel ?? titleLabel;
  const spec: MenuItem['spec'] = {
    ...rest,
    label,
    run(state: EditorState, dispatch: (tr: Transaction) => void, view: EditorView, event: Event) {
      cmd(state, dispatch, view ?? undefined);
    },
    select(state: EditorState) {
      return cmd(state);
    },
  };
  return new MenuItem(spec);
}

function markActive(state: EditorState, type: MarkType): boolean {
  const { from, $from, to, empty } = state.selection;
  if (empty) return !!type.isInSet(state.storedMarks || $from.marks());
  else return state.doc.rangeHasMark(from, to, type);
}

function markItem(markType: MarkType, options: MenuItemInit): MenuItem {
  const passedOptions: MenuItemInit = {
    ...options,
    active(state: EditorState) {
      return markActive(state, markType);
    },
  };
  return cmdItem(toggleMark(markType), passedOptions);
}

function fullScreenItem(): ExtendedMenuItem {
  return new MenuItem({
    title: msg('full screen mode', { accessKey: 'u' }),
    icon: { dom: $('<span class="fa fa-arrows-alt baselined-icon"></span>')[0] },
    active(this: { enabled?: boolean }) {
      return this.enabled ?? false;
    },
    run(
      this: { enabled?: boolean },
      state: EditorState,
      _dispatch: ((tr: Transaction) => void) | undefined,
      view?: EditorView | null
    ) {
      if (!view) return false;

      const $rteContainer = $(view.dom).closest('.rte-container');
      const idMatch = $rteContainer[0]?.id.match(/\d+/);
      const id = idMatch ? idMatch[0] : undefined;
      if (!id) return false;

      const rte = libreviews.activeRTEs[id];
      if (!rte) return false;

      if (!this.enabled) {
        rte.enterFullScreen?.();
        this.enabled = true;
      } else {
        rte.exitFullScreen?.();
        this.enabled = false;
      }
      view.updateState(state);
      return true;
    },
  }) as ExtendedMenuItem;
}

function uploadModalItem(mediaNodes: MediaNodeTypes, schema: Schema): MenuItem {
  return new MenuItem({
    title: msg('upload and insert media'),
    icon: { dom: $('<span class="fa fa-cloud-upload baselined-icon"><span>')[0] },
    active() {
      return false;
    },
    run(state: EditorState, dispatch?: (tr: Transaction) => void, view?: EditorView | null) {
      if (!dispatch || !view) return;

      // For some forms, we submit uploaded file IDs so they can be processed
      // server-side
      const $form = $(view.dom).closest('form[data-submit-uploaded-files]');

      uploadModal(uploads => {
        const [firstUpload] = uploads as UploadMetadata[];
        if (!firstUpload) return;

        const attrs: MediaAttributes = {
          src: `/static/uploads/${encodeURIComponent(firstUpload.uploadedFileName)}`,
        };
        const nodeType = guessMediaType(attrs.src) as MediaKind;
        const description = generateDescriptionFromUpload(firstUpload);
        let tr = state.tr.replaceSelectionWith(mediaNodes[nodeType].createAndFill(attrs as Attrs));
        tr = addCaption({ description, schema, state, transaction: tr });
        dispatch(tr);

        if ($form.length) {
          $form.append(
            `<input type="hidden" ` + ` name="uploaded-file-${firstUpload.fileID}" value="1">`
          );
          if ($form.find('#social-media-image-select').length) {
            const language = config.language ?? 'en';
            const localizedDescription = firstUpload.description[language] ?? '';
            let summarizedDesc = localizedDescription.substring(0, 80);
            if (localizedDescription.length > 80) summarizedDesc += '...';
            $('#social-media-image-select').append(
              `<option value="${firstUpload.fileID}">` +
                `${firstUpload.uploadedFileName}: ${summarizedDesc}` +
                '</option>'
            );
          }
        }
        view.focus();
      });
    },
  });
}

function generateDescriptionFromUpload(upload: UploadMetadata): string {
  // API returns escaped HTML; editor will re-escape it
  const language = config.language ?? 'en';
  const rawDescription = upload.description[language] ?? '';
  const description = decodeHTML(rawDescription);
  const creator = upload.creator && upload.creator[language];
  let license: string;
  switch (upload.license) {
    case 'fair-use':
      license = msg('fair use in caption');
      break;
    case 'cc-0':
      license = msg('public domain in caption');
      break;
    default:
      license = msg('license in caption', {
        stringParam: msg(`${upload.license} short`),
      });
  }

  let rights;
  if (!creator)
    // Own work
    rights = msg('rights in caption, own work', { stringParam: license });
  else
    rights = msg("rights in caption, someone else's work", {
      stringParams: [creator, license],
    });
  const caption = msg('caption', { stringParams: [description, rights] });
  // Final newline is important to ensure resulting markdown is parsed correctly
  return caption + '\n';
}

function formatCustomWarningItem(nodeType: NodeType): MenuItem {
  return new MenuItem({
    title: msg('format as custom warning help'),
    label: msg('format as custom warning'),
    run(state: EditorState, dispatch?: (tr: Transaction) => void, view?: EditorView | null) {
      if (!view) return;
      const prompt = {
        view: view as unknown as PromptSpec['view'],
        title: msg('format as custom warning dialog title'),
        fields: {
          message: new TextField({
            label: msg('custom warning text'),
            required: true,
          }),
        },
        callback(attrs) {
          // Used to translate node back into markdown
          const warningAttrs = attrs as MediaAttributes;
          warningAttrs.markup = `warning ${warningAttrs.message}`;
          const command = wrapIn(nodeType, warningAttrs);
          command(state, dispatch ?? view.dispatch);
          view.focus();
        },
      };
      openPrompt(prompt);
    },
    select(state: EditorState) {
      return wrapIn(nodeType)(state);
    },
  });
}

function linkItem(schema: Schema): MenuItem {
  const linkMark = schema.marks.link;
  if (!linkMark) throw new Error('Link mark not found in schema');

  return new MenuItem({
    title: msg('add or remove link', { accessKey: 'k' }),
    icon: icons.link,
    active(state: EditorState) {
      return markActive(state, linkMark);
    },
    run(state: EditorState, dispatch?: (tr: Transaction) => void, view?: EditorView | null) {
      if (!view) return false;

      if (markActive(state, linkMark)) {
        toggleMark(linkMark)(state, dispatch ?? view.dispatch);
        return true;
      }
      const required = true;
      const fields: Record<string, TextField> = {
        href: new TextField({
          label: msg('web address'),
          required,
          clean: (val: string) => (!/^https?:\/\//i.test(val) ? 'http://' + val : val),
        }),
      };
      // User has not selected any text, so needs to provide it via dialog
      if (view.state.selection.empty) {
        fields.linkText = new TextField({
          label: msg('link text'),
          required,
          clean: (val: string) => val.trim(),
        });
      }
      openPrompt({
        view: view as unknown as PromptSpec['view'],
        title: msg('add link dialog title'),
        fields,
        callback(attrs) {
          const linkAttrs = attrs as Record<string, string>;
          if (!linkAttrs.linkText) {
            // Transform selected text into link
            toggleMark(linkMark, linkAttrs)(view.state, view.dispatch);
            // Advance cursor to end of selection (not necessarily head,
            // depending on selection direction)
            const rightmost =
              view.state.selection.$anchor.pos > view.state.selection.$head.pos
                ? view.state.selection.$anchor
                : view.state.selection.$head;
            view.dispatch(view.state.tr.setSelection(TextSelection.between(rightmost, rightmost)));
            // Disable link mark so user can now type normally again
            toggleMark(linkMark, linkAttrs)(view.state, view.dispatch);
          } else {
            view.dispatch(
              view.state.tr
                .replaceSelectionWith(schema.text(linkAttrs.linkText))
                .addMark(
                  view.state.selection.$from.pos,
                  view.state.selection.$from.pos + linkAttrs.linkText.length,
                  linkMark.create({ href: linkAttrs.href })
                )
            );
          }
          view.focus();
        },
      });
      return true;
    },
  });
}

function wrapListItem(nodeType: NodeType, options: MenuItemInit): MenuItem {
  const { attrs, ...rest } = options;
  return cmdItem(wrapInList(nodeType, attrs as Attrs | undefined), rest);
}

function headingItems(nodeType: NodeType): MenuItem[] {
  const headingItems: MenuItem[] = [];
  for (let i = 1; i <= 6; i++)
    headingItems[i - 1] = blockTypeItem(nodeType, {
      title: msg('format as level heading help', { accessKey: String(i), numberParam: i }),
      label: msg('format as level heading', { numberParam: i }),
      attrs: { level: i },
    });
  return headingItems;
}

function buildMenuItems(schema: Schema): { menu: MenuElement[][]; items: EditorMenuItems } {
  const maybeMediaNodes = {
    image: schema.nodes.image,
    video: schema.nodes.video,
    audio: schema.nodes.audio,
  };

  if (!maybeMediaNodes.image || !maybeMediaNodes.video || !maybeMediaNodes.audio)
    throw new Error('Missing media nodes in schema');

  const mediaNodes: MediaNodeTypes = {
    image: maybeMediaNodes.image,
    video: maybeMediaNodes.video,
    audio: maybeMediaNodes.audio,
  };

  const containerWarning = schema.nodes.container_warning;
  const headingNode = schema.nodes.heading;
  const paragraphNode = schema.nodes.paragraph;
  const codeBlockNode = schema.nodes.code_block;
  const blockquoteNode = schema.nodes.blockquote;
  const bulletListNode = schema.nodes.bullet_list;
  const orderedListNode = schema.nodes.ordered_list;
  const horizontalRuleNode = schema.nodes.horizontal_rule;

  if (
    !containerWarning ||
    !headingNode ||
    !paragraphNode ||
    !codeBlockNode ||
    !blockquoteNode ||
    !bulletListNode ||
    !orderedListNode ||
    !horizontalRuleNode
  )
    throw new Error('Schema is missing required nodes for the editor menu');

  const items: EditorMenuItems = {
    toggleStrong: markItem(schema.marks.strong, {
      title: msg('toggle bold', { accessKey: 'b' }),
      icon: icons.strong,
    }),
    toggleEm: markItem(schema.marks.em, {
      title: msg('toggle italic', { accessKey: 'i' }),
      icon: icons.em,
    }),
    toggleCode: markItem(schema.marks.code, {
      title: msg('toggle code', { accessKey: '`' }),
      icon: icons.code,
    }),
    toggleLink: linkItem(schema),
    insertMedia: insertMediaItem(mediaNodes, schema),
    insertHorizontalRule: horizontalRuleItem(horizontalRuleNode),
    wrapBulletList: wrapListItem(bulletListNode, {
      title: msg('format as bullet list', { accessKey: '8' }),
      icon: icons.bulletList,
    }),
    wrapOrderedList: wrapListItem(orderedListNode, {
      title: msg('format as numbered list', { accessKey: '9' }),
      icon: icons.orderedList,
    }),
    wrapBlockQuote: wrapItem(blockquoteNode, {
      title: msg('format as quote', { accessKey: '>' }),
      icon: icons.blockquote,
    }),
    makeParagraph: blockTypeItem(paragraphNode, {
      title: msg('format as paragraph help', { accessKey: '0' }),
      label: msg('format as paragraph'),
    }),
    makeCodeBlock: blockTypeItem(codeBlockNode, {
      title: msg('format as code block help'),
      label: msg('format as code block'),
    }),
    formatSpoilerWarning: wrapItem(containerWarning, {
      title: msg('format as spoiler help'),
      label: msg('format as spoiler'),
      attrs: { markup: 'spoiler', message: msg('spoiler warning') },
    }),
    formatNSFWWarning: wrapItem(containerWarning, {
      title: msg('format as nsfw help'),
      label: msg('format as nsfw'),
      attrs: { markup: 'nsfw', message: msg('nsfw warning') },
    }),
    formatCustomWarning: formatCustomWarningItem(containerWarning),
    makeHeading: headingItems(headingNode),
    fullScreen: fullScreenItem(),
    undo: undoItem,
    redo: redoItem,
    joinUp: joinUpItem,
    lift: liftItem,
  };

  // Only trusted users can upload files directly from within the RTE.
  if (config.isTrusted) items.upload = uploadModalItem(mediaNodes, schema);

  const insertDropdown = new Dropdown([items.insertMedia, items.insertHorizontalRule], {
    label: msg('insert'),
    title: msg('insert help'),
  });

  const headingSubmenu = new DropdownSubmenu([...items.makeHeading], {
    label: msg('format as heading'),
  });

  const typeDropdown = new Dropdown(
    [
      items.makeParagraph,
      items.makeCodeBlock,
      items.formatSpoilerWarning,
      items.formatNSFWWarning,
      items.formatCustomWarning,
      headingSubmenu,
    ],
    {
      label: msg('format block'),
      title: msg('format block help'),
    }
  );

  const mediaOptions: MenuElement[] = [insertDropdown];

  // Only trusted users can upload files directly via the RTE.
  if (items.upload) mediaOptions.push(items.upload);

  const menu: MenuElement[][] = [
    [items.toggleStrong, items.toggleEm, items.toggleCode, items.toggleLink],
    mediaOptions,
    [
      typeDropdown,
      items.wrapBulletList,
      items.wrapOrderedList,
      items.wrapBlockQuote,
      items.joinUp,
      items.lift,
    ],
    [items.undo, items.redo],
    [items.fullScreen],
  ];

  // We expose the items object so it can be used to externally trigger a menu
  // function, e.g., via a keyboard shortcut
  return { menu, items };
}

export { buildMenuItems };
