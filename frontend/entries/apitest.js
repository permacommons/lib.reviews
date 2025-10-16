import './jquery-globals.js';
import loadAfterGlobals from './load-after-globals.js';

loadAfterGlobals(() => import('../upload-modal.js'));
