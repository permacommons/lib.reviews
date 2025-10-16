import './jquery-globals.js';
import 'jquery-powertip';
import 'jquery-modal';
import sisyphusSource from 'sisyphus.js/sisyphus.js?raw';
import acSource from '../lib/ac.js?raw';

if (typeof window !== 'undefined') {
  const ensureScript = (key, source) => {
    const marker = `data-libreviews-${key}`;
    if (document.head.querySelector(`script[${marker}]`))
      return;
    const script = document.createElement('script');
    script.type = 'text/javascript';
    script.setAttribute(marker, 'true');
    script.text = source;
    document.head.appendChild(script);
  };

  ensureScript('sisyphus', sisyphusSource);

  ensureScript('ac', acSource);
  const globalSource = typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : globalThis);
  if (globalSource && globalSource.AC && !window.AC)
    window.AC = globalSource.AC;
}

const libreviewsPromise = import('../libreviews.js');
if (typeof window !== 'undefined')
  window.libreviewsReady = libreviewsPromise;

libreviewsPromise.catch(error => {
  // Surface loading issues for debugging without breaking legacy globals.
  // eslint-disable-next-line no-console
  console.error('Failed to load libreviews.js:', error);
});
