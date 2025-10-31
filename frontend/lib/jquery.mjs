import jQuery from 'jquery';

if (typeof window !== 'undefined') {
  if (!window.jQuery)
    window.jQuery = jQuery;
  if (!window.$)
    window.$ = jQuery;
}

export default jQuery;
