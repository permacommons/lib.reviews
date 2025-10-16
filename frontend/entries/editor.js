import loadAfterGlobals from './load-after-globals.js';
import 'prosemirror-view/style/prosemirror.css';
import 'prosemirror-menu/style/menu.css';
import '../styles/editor-overrides.css';

loadAfterGlobals(() => import('../editor.js'));
