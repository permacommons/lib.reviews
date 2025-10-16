const waitForGlobals = () => {
  if (typeof window === 'undefined')
    return Promise.resolve();
  if (window.libreviewsReady)
    return window.libreviewsReady;
  return Promise.resolve();
};

export default function loadAfterGlobals(loader) {
  if (typeof loader !== 'function')
    throw new TypeError('loadAfterGlobals expects a function returning a Promise.');
  return waitForGlobals().then(() => loader());
}
