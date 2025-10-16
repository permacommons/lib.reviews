import $ from './jquery.js';
import sisyphusSource from 'sisyphus.js/sisyphus.js?raw';

let sisyphusInitialized = false;

function initializeSisyphus() {
  if (sisyphusInitialized)
    return $;

  if (typeof window === 'undefined' || typeof document === 'undefined')
    return $;

  if (typeof $.fn.sisyphus !== 'function') {
    const loadSisyphus = new Function('window', 'document', 'jQuery', sisyphusSource);
    loadSisyphus(window, document, $);
  }

  sisyphusInitialized = true;
  return $;
}

export { initializeSisyphus };
export default initializeSisyphus;
