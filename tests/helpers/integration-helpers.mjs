export const extractCSRF = html => {
  let matches = html.match(/<input type="hidden" value="(.*?)" name="_csrf">/);
  return matches && matches[1] ? matches[1] : null;
};
