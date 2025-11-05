import {
  chainCommands,
  exitCode,
  selectParentNode,
  setBlockType,
  toggleMark,
  wrapIn,
} from 'prosemirror-commands';
import { redo, undo } from 'prosemirror-history';
import { undoInputRule } from 'prosemirror-inputrules';
import type { MarkType, NodeType, Schema } from 'prosemirror-model';
import { liftListItem, sinkListItem, splitListItem, wrapInList } from 'prosemirror-schema-list';
import type { Command, EditorState, Transaction } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import type { EditorMenuItems } from './editor-menu.ts';

const mac = typeof navigator !== 'undefined' ? /Mac/.test(navigator.platform) : false;

type Keymap = Record<string, Command>;

export function getExtendedKeymap(schema: Schema, menuItems: EditorMenuItems): Keymap {
  const keymap: Keymap = {};

  keymap['Mod-z'] = undo;
  keymap['Shift-Mod-z'] = redo;
  keymap['Backspace'] = undoInputRule;
  if (!mac) keymap['Mod-y'] = redo;

  mapMarkIfSupported(keymap, 'Mod-b', schema.marks.strong, toggleMark);
  mapMarkIfSupported(keymap, 'Mod-i', schema.marks.em, toggleMark);
  mapMarkIfSupported(keymap, 'Mod-`', schema.marks.code, toggleMark);

  mapNodeIfSupported(keymap, 'Shift-Ctrl-7', schema.nodes.ordered_list, wrapInList);
  mapNodeIfSupported(keymap, 'Shift-Ctrl-8', schema.nodes.bullet_list, wrapInList);
  mapNodeIfSupported(keymap, 'Ctrl->', schema.nodes.blockquote, wrapIn);
  mapNodeIfSupported(keymap, 'Enter', schema.nodes.list_item, splitListItem);
  mapNodeIfSupported(keymap, 'Mod-[', schema.nodes.list_item, liftListItem);
  mapNodeIfSupported(keymap, 'Mod-]', schema.nodes.list_item, sinkListItem);
  mapNodeIfSupported(keymap, 'Shift-Ctrl-0', schema.nodes.paragraph, setBlockType);
  mapNodeIfSupported(keymap, 'Shift-Ctrl-\\', schema.nodes.code_block, setBlockType);

  // Special cases
  if (schema.nodes.hard_break) {
    const hardBreak = schema.nodes.hard_break;
    const cmd = chainCommands(
      exitCode,
      (state: EditorState, dispatch?: (tr: Transaction) => void) => {
        if (!dispatch || !hardBreak) return false;
        dispatch(state.tr.replaceSelectionWith(hardBreak.create()).scrollIntoView());
        return true;
      }
    );
    keymap['Mod-Enter'] = cmd;
    keymap['Shift-Enter'] = cmd;
    if (mac) keymap['Ctrl-Enter'] = cmd;
  }

  if (schema.nodes.heading) {
    for (let level = 1; level <= 6; level++)
      keymap[`Shift-Ctrl-${level}`] = setBlockType(schema.nodes.heading, { level });
  }

  if (schema.nodes.horizontal_rule) {
    const horizontalRule = schema.nodes.horizontal_rule;
    keymap['Mod-_'] = (state, dispatch) => {
      if (!dispatch || !horizontalRule) return false;
      dispatch(state.tr.replaceSelectionWith(horizontalRule.create()).scrollIntoView());
      return true;
    };
  }

  keymap['Mod-k'] = (state, dispatch, view) => {
    const runToggleLink = menuItems.toggleLink.spec.run as unknown as (
      state: EditorState,
      dispatch?: (tr: Transaction) => void,
      view?: EditorView | null
    ) => boolean | void;
    const effectiveDispatch = dispatch ?? view?.dispatch;
    runToggleLink?.(state, effectiveDispatch ?? undefined, view ?? undefined);
    return true;
  };

  // This is useful primarily as an easter egg for advanced users; it lets you
  // progressively create larger selection blocks (e.g., an image with its
  // caption, a list item and then the whole list), which is nice for bulk
  // deletions and such.
  keymap['Mod-\\'] = selectParentNode;

  // Toggle full screen mode
  keymap['Mod-u'] = (state, dispatch, view) => {
    const effectiveDispatch = dispatch ?? view?.dispatch;
    const runFullScreen = menuItems.fullScreen.spec.run as unknown as (
      state: EditorState,
      dispatch?: (tr: Transaction) => void,
      view?: EditorView | null
    ) => boolean | void;
    runFullScreen(state, effectiveDispatch ?? undefined, view ?? undefined);
    return true;
  };

  // Exit full screen on escape as well
  keymap['Escape'] = (state, dispatch, view) => {
    if (menuItems.fullScreen.spec.enabled) {
      const runFullScreen = menuItems.fullScreen.spec.run as unknown as (
        state: EditorState,
        dispatch?: (tr: Transaction) => void,
        view?: EditorView | null
      ) => boolean | void;
      runFullScreen(state, dispatch ?? view?.dispatch ?? undefined, view ?? undefined);
    }
    return true;
  };

  return keymap;
}

function mapNodeIfSupported(
  keymap: Keymap,
  key: string,
  type: NodeType | null | undefined,
  factory: (type: NodeType) => Command
): void {
  if (type) keymap[key] = factory(type);
}

function mapMarkIfSupported(
  keymap: Keymap,
  key: string,
  type: MarkType | null | undefined,
  factory: (type: MarkType) => Command
): void {
  if (type) keymap[key] = factory(type);
}
