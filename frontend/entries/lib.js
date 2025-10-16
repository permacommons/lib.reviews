import '../lib/jquery.js';
import 'jquery-powertip';
import 'jquery-modal';
import initializeSisyphus from '../lib/sisyphus.js';
import { initializeLibreviews } from '../libreviews.js';

if (typeof window !== 'undefined') {
  initializeSisyphus();

  const api = initializeLibreviews();
  if (!window.libreviews)
    window.libreviews = api;
}
