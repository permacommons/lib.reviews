import './jquery-globals.js';
import 'jquery-powertip';
import 'jquery-modal';
import sisyphusSource from 'sisyphus.js/sisyphus.js?raw';
import Autocomplete from '../lib/ac.mjs';
import { initializeLibreviews } from '../libreviews.js';

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

  if (!window.AC)
    window.AC = Autocomplete;

  const api = initializeLibreviews();
  if (!window.libreviews)
    window.libreviews = api;
}
