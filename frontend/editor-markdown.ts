import MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token.mjs';
import markdownItContainer from 'markdown-it-container';
import { html5Media } from 'markdown-it-html5-media';
import type { MarkdownSerializerState } from 'prosemirror-markdown';
import {
  defaultMarkdownParser,
  defaultMarkdownSerializer,
  MarkdownParser,
  schema,
} from 'prosemirror-markdown';
import type { DOMOutputSpec, NodeSpec, Node as ProseMirrorNode } from 'prosemirror-model';
import { Schema } from 'prosemirror-model';
import { msg } from './libreviews.js';

const md = new MarkdownIt('commonmark', { html: false });

// Container module with our custom fenced blocks
md.use(markdownItContainer, 'warning', {
  validate: params =>
    /^(spoiler|nsfw)$/.test(params.trim()) || /^warning\s+\S{1}.*$/.test(params.trim()),
});

md.use(html5Media);

// <video> and <audio> schema are largely identical
const getMediaSchema = (type: 'video' | 'audio'): NodeSpec => ({
  inline: true,
  attrs: {
    src: {},
    title: { default: null },
    description: { default: null },
  },
  group: 'inline',
  draggable: true,
  parseDOM: [
    {
      tag: `${type}[src]`,
      getAttrs(dom) {
        return {
          src: (dom as HTMLElement).getAttribute('src'),
          title: (dom as HTMLElement).getAttribute('title'),
        };
      },
    },
  ],
  toDOM(node): DOMOutputSpec {
    // Fallback description is omitted in RTE view, no point since user
    // must be able to play HTML5 media in order to insert them
    return [
      type,
      {
        src: node.attrs.src,
        title: node.attrs.title,
        class: `html5-${type}-player-in-editor`,
        controls: true,
      },
    ];
  },
});

// Customize the schema to add a new node type that ProseMirror can understand.
// We treat 'warning' as a top-level group to prevent warnings from being
// nested.
const markdownSchema = new Schema({
  nodes: schema.spec.nodes
    .update('doc', {
      content: '(paragraph | block | warning)+',
    })
    .append({
      video: getMediaSchema('video'),
      audio: getMediaSchema('audio'),
      container_warning: {
        content: 'block+',
        group: 'warning',
        attrs: { message: { default: '' }, markup: { default: '' } },
        parseDOM: [{ tag: 'details' }],
        toDOM(node): DOMOutputSpec {
          return [
            'details',
            {
              open: 'true',
              class: 'content-warning',
            },
            [
              'summary',
              {
                class: 'content-warning-notice',
                style: 'pointer-events:none;user-select:none;-moz-user-select:none;',
                contenteditable: 'false',
              },
              node.attrs.message,
            ],
            [
              'div',
              {
                class: 'dangerous-content-in-editor',
              },
              0, // Placeholder for actual content
            ],
          ];
        },
      } satisfies NodeSpec,
    }),
  marks: schema.spec.marks,
});

export { markdownSchema };

type SerializerFn = (state: MarkdownSerializerState, node: ProseMirrorNode) => void;

// Serialize content back into markdown
defaultMarkdownSerializer.nodes['container_warning'] = ((state, node) => {
  state.write(`::: ${node.attrs.markup}\n\n`);
  state.renderContent(node);
  state.write(':::');
  state.closeBlock(node);
}) as SerializerFn;

const mediaSerializer: SerializerFn = (state, node) => {
  const escapeQuotes = (str: string): string => str.replace(/(["'])/g, '\\$&');
  const title = node.attrs.title ? ` "${escapeQuotes(node.attrs.title)}"` : '';
  state.write(`![${node.attrs.description || ''}](${node.attrs.src}${title})`);
};

defaultMarkdownSerializer.nodes.video = mediaSerializer;
defaultMarkdownSerializer.nodes.audio = mediaSerializer;

export { defaultMarkdownSerializer as markdownSerializer };

type MarkdownParseSpec = {
  node?: string;
  block?: string;
  mark?: string;
  attrs?: Record<string, unknown> | null;
  getAttrs?: (token: Token) => Record<string, unknown> | null;
  noCloseToken?: boolean;
  ignore?: boolean;
};

const defaultMarkdownParserTokens = defaultMarkdownParser.tokens as Record<
  string,
  MarkdownParseSpec
>;

// Translate tokens from markdown parser into metadata for the ProseMirror node

const getMediaParserTokens = (type: 'video' | 'audio'): MarkdownParseSpec => ({
  node: type,
  getAttrs: (tok: Token) => ({
    src: tok.attrGet('src'),
    title: tok.attrGet('title') || null,
    description: tok.children && tok.children[0] ? tok.children[0].content : null,
  }),
});

defaultMarkdownParserTokens.video = getMediaParserTokens('video');
defaultMarkdownParserTokens.audio = getMediaParserTokens('audio');

defaultMarkdownParserTokens.container_warning = {
  block: 'container_warning',
  getAttrs: (tok: Token) => {
    const info = tok.info.trim();
    const rv: { markup: string; message?: string } = { markup: info };
    if (info === 'spoiler' || info === 'nsfw') {
      rv.message = msg(`${info} warning`);
    } else if (/^warning\s+\S{1}.*/.test(info)) {
      rv.message = (info.match(/^warning\s+(\S{1}.*)$/) || [])[1];
    }
    return rv;
  },
};

const markdownParser = new MarkdownParser(markdownSchema, md, defaultMarkdownParserTokens);

export { markdownParser };
