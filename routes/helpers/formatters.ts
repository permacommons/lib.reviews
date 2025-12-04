import escapeHTML from 'escape-html';

/**
 * Convert URLs in text to clickable links.
 */
export function autolink(text: string): string {
  if (!text) return '';

  const escaped = escapeHTML(text);
  const urlRegex = /(https?:\/\/[^\s]+)/g;

  return escaped.replace(urlRegex, url => {
    return `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`;
  });
}
