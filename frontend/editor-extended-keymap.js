import { undo, redo } from 'prosemirror-history';
import { undoInputRule } from 'prosemirror-inputrules';
import { wrapIn, setBlockType, chainCommands, toggleMark, exitCode, selectParentNode } from 'prosemirror-commands';
import { wrapInList, splitListItem, liftListItem, sinkListItem } from 'prosemirror-schema-list';

const mac = typeof navigator != "undefined" ? /Mac/.test(navigator.platform) : false;

// In order to avoid having to keep updating this file, we check the schema
// for supported node and mark types.
export function getExtendedKeymap(schema, menuItems) {
  let keymap = {};

  keymap['Mod-z'] = undo;
  keymap['Shift-Mod-z'] = redo;
  keymap['Backspace'] = undoInputRule;
  if (!mac)
    keymap['Mod-y'] = redo;

  let conditionalMappings = {
    'Mod-b': {
      type: schema.marks.strong,
      fn: toggleMark
    },
    'Mod-i': {
      type: schema.marks.em,
      fn: toggleMark
    },
    // The ` character is used for code blocks in markdown
    'Mod-`': {
      type: schema.marks.code,
      fn: toggleMark
    },
    // These mappings are used in Google Docs, as well
    'Shift-Ctrl-7': {
      type: schema.nodes.ordered_list,
      fn: wrapInList
    },
    'Shift-Ctrl-8': {
      type: schema.nodes.bullet_list,
      fn: wrapInList
    },
    'Ctrl->': {
      type: schema.nodes.blockquote,
      fn: wrapIn
    },
    'Enter': {
      type: schema.nodes.list_item,
      fn: splitListItem
    },
    'Mod-[': {
      type: schema.nodes.list_item,
      fn: liftListItem
    },
    'Mod-]': {
      type: schema.nodes.list_item,
      fn: sinkListItem
    },
    'Shift-Ctrl-0': {
      type: schema.nodes.paragraph,
      fn: setBlockType
    },
    'Shift-Ctrl-\\': {
      type: schema.nodes.code_block,
      fn: setBlockType
    }
  };

  let mapIfSupported = (key, type, fn) => {
    if (type)
      keymap[key] = fn(type);
  };

  for (let key in conditionalMappings)
    mapIfSupported(key, conditionalMappings[key].type, conditionalMappings[key].fn);

  // Special cases

  if (schema.nodes.hard_break) {
    // exitCode: function to exit a code block before inserting a break.
    let cmd = chainCommands(exitCode, (state, dispatch) => {
      // state.tr: Start a new transaction from this state
      dispatch(state.tr.replaceSelectionWith(schema.nodes.hard_break.create()).scrollIntoView());
      return true;
    });
    keymap['Mod-Enter'] = cmd;
    keymap['Shift-Enter'] = cmd;
    if (mac)
      keymap['Ctrl-Enter'] = cmd;
  }

  if (schema.nodes.heading) {
    for (let level = 1; level <= 6; level++)
      keymap[`Shift-Ctrl-${level}`] = setBlockType(schema.nodes.heading, { level });
  }

  if (schema.nodes.horizontal_rule) {
    keymap['Mod-_'] = (state, dispatch) => {
      dispatch(state.tr.replaceSelectionWith(schema.nodes.horizontal_rule.create()).scrollIntoView());
      return true;
    };
  }

  keymap['Mod-k'] = (state, dispatch, view) => {
    menuItems.toggleLink.spec.run(state, dispatch, view);
    return true;
  };

  // This is useful primarily as an easter egg for advanced users; it lets you
  // progressively create larger selection blocks (e.g., an image with its
  // caption, a list item and then the whole list), which is nice for bulk
  // deletions and such.
  keymap['Mod-\\'] = selectParentNode;

  // Toggle full screen mode
  keymap['Mod-u'] = (state, dispatch, view) => {
    menuItems.fullScreen.spec.run(state, dispatch, view);
    return true;
  };

  // Exit full screen on escape as well
  keymap['Escape'] = (state, dispatch, view) => {
    if (menuItems.fullScreen.spec.enabled)
      menuItems.fullScreen.spec.run(state, dispatch, view);
    return true;
  };

  return keymap;
}
