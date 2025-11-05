import MarkdownIt from 'markdown-it';
import container from 'markdown-it-container';
import { html5Media } from 'markdown-it-html5-media';
import i18n from 'i18n';

type MarkdownItWithMessages = MarkdownIt & { getMarkdownMessageKeys?: () => string[] };

/**
 * Return the set of internationalized markdown notice keys that must be
 * bundled with the frontend (e.g., spoiler/NSFW warnings) so plugins can
 * render localized container labels.
 *
 * @returns Array of message keys to include with frontend bundles
 */
const getMarkdownMessageKeys = () => Array.from(markdownMessages);

/** Keys that must be bundled with the frontend for markdown notices. */
const markdownMessages = ['nsfw warning', 'spoiler warning'] as const;
(MarkdownIt.prototype as MarkdownItWithMessages).getMarkdownMessageKeys = getMarkdownMessageKeys;

/**
 * MarkdownIt instance configured to mirror the legacy renderer: linkifying
 * URLs, supporting soft-break paragraphs, and exposing spoiler/NSFW containers
 * through the generalized container plugin.
 */
const md = new MarkdownIt({
  linkify: true,
  breaks: true,
  typographer: true,
});

md.use(container, 'warning', {
  // Can take the form of specific built-in notices ("::: spoiler", "::: nsfw")
  // which are mapped against internationalized messages (that are treated
  // as content, i.e. they'll be saved into the rendered output), or a custom
  // notice text (":::warning Here there be dragons")
  validate(params: string) {
    return /^(spoiler|nsfw)$/.test(params.trim()) || /^warning\s+\S{1}.*$/.test(params.trim());
  },

  render(
    tokens: Array<{ nesting: number; info: string }>,
    idx: number,
    _options: unknown,
    env: { language?: string }
  ) {
    if (tokens[idx].nesting === 1) {
      // Opening tag
      let match: RegExpMatchArray | null;
      let notice: string;
      const trimmed = tokens[idx].info.trim();
      if ((match = trimmed.match(/^(spoiler|nsfw)$/))) {
        notice = i18n.__({
          phrase: `${match[1]} warning`,
          locale: env.language || 'en',
        });
      } else if ((match = trimmed.match(/^warning\s+(\S{1}.*)$/))) {
        notice = md.utils.escapeHtml(match[1]);
      } else {
        // Should not occur given validate function above
        notice = '';
      }
      return `<details class="content-warning"><summary tabindex="0" class="content-warning-notice">${notice}</summary><div class="dangerous-content nojs-visible">\n`;
    } else {
      // Closing tag
      return '</div></details>\n';
    }
  },
});

md.use(html5Media, {
  translateFn: (locale: string | undefined = 'en', messageKey: string, messageParams: any[] = []) =>
    i18n.__({ locale, phrase: messageKey }, ...messageParams),
});

export { getMarkdownMessageKeys };
export default md;
