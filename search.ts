import type {
  ConfigOptions,
  DeleteDocumentParams,
  IndexDocumentParams,
  SearchParams,
  SearchResponse
} from 'elasticsearch';
import elasticsearch from 'elasticsearch';
import config from 'config';

import debug from './util/debug.ts';
import mlString from './dal/lib/ml-string.ts';
import languages from './locales/languages.ts';

type LocaleCode = LibReviews.LocaleCode;

type ElasticClient = elasticsearch.Client;

let client: ElasticClient | null = null;

function createClient(): ElasticClient {
  const options: ConfigOptions = {
    host: `${config.search.host}:${config.search.port}`,
    log: config.search.log
  };
  return new elasticsearch.Client(options);
}

function getClient(): ElasticClient {
  if (!client)
    client = createClient();
  return client;
}

// All supported stemmers as of ElasticSearch 5.2.0
const analyzers: Record<string, string> = {
  ar: 'arabic',
  hy: 'armenian',
  eu: 'basque',
  bn: 'bengali',
  pt: 'brazilian',
  bg: 'bulgarian',
  ca: 'catalan',
  zh: 'cjk',
  'zh-Hant': 'cjk',
  cs: 'czech',
  da: 'danish',
  nl: 'dutch',
  en: 'english',
  et: 'estonian',
  fi: 'finnish',
  fr: 'french',
  gl: 'galician',
  de: 'german',
  el: 'greek',
  hi: 'hindi',
  hu: 'hungarian',
  id: 'indonesian',
  ga: 'irish',
  it: 'italian',
  lv: 'latvian',
  lt: 'lithuanian',
  no: 'norwegian',
  fa: 'persian',
  'pt-PT': 'portuguese',
  ro: 'romanian',
  ru: 'russian',
  ckb: 'sorani',
  es: 'spanish',
  sv: 'swedish',
  tr: 'turkish',
  th: 'thai'
};

const search = {

  // For testing queries
  _raw<TResponse = unknown>(params: SearchParams): Promise<SearchResponse<TResponse>> {
    return getClient().search<TResponse>(params);
  },

  // Find things by their label or description; performs language fallback
  searchThings(query: string, lang: LocaleCode = 'en'): Promise<SearchResponse<any>> {
    const options = search.getSearchOptions('label', lang);
    const descriptionOptions = search.getSearchOptions('description', lang);
    const subtitleOptions = search.getSearchOptions('subtitle', lang);
    const authorsOptions = search.getSearchOptions('authors', lang);

    // Combine all search fields
    options.fields = options.fields
      .concat(descriptionOptions.fields)
      .concat(subtitleOptions.fields)
      .concat(authorsOptions.fields);

    // Combine all highlight fields
    Object.assign(options.highlight.fields,
      descriptionOptions.highlight.fields,
      subtitleOptions.highlight.fields,
      authorsOptions.highlight.fields
    );

    return getClient().search({
      index: 'libreviews',
      body: {
        query: {
          bool: {
            must: [
              {
                match: {
                  type: 'thing'
                }
              },
              {
                simple_query_string: {
                  fields: options.fields,
                  query,
                  default_operator: 'and'
                }
              }
            ],
          },
        },
        highlight: options.highlight
      }
    });

  },

  // Find reviews by their text or title; performs language fallback and includes
  // the thing via parent-child join. The review is returned as an inner hit.
  searchReviews(query: string, lang: LocaleCode = 'en'): Promise<SearchResponse<any>> {
    // Add text fields
    const options = search.getSearchOptions('text', lang);

    // Add title fields
    const titleOptions = search.getSearchOptions('title', lang);
    options.fields = options.fields.concat(titleOptions.fields);

    Object.assign(options.highlight.fields, titleOptions.highlight.fields);
    return getClient().search({
      index: 'libreviews',
      body: {
        query: {
          has_child: {
            type: 'review',
            query: {
              simple_query_string: {
                fields: options.fields,
                query,
                default_operator: 'and'
              }
            },
            inner_hits: {
              highlight: options.highlight
            },
          }
        }
      }
    });
  },

  // We may be getting highlights from both the processed (stememd) index
  // and the unprocessed one. This function filters the dupes from inner hits.
  filterDuplicateInnerHighlights(hits: any[], type: string): any[] {
    for (const hit of hits) {
      if (hit.inner_hits && hit.inner_hits[type] && hit.inner_hits[type].hits) {
        for (const innerHit of hit.inner_hits[type].hits.hits) {
          if (innerHit.highlight) {
            const seenHighlights: string[] = [];
            for (const key of Object.keys(innerHit.highlight)) {
              innerHit.highlight[key] = innerHit.highlight[key].filter((highlight: string) => {
                if (seenHighlights.indexOf(highlight) === -1) {
                  seenHighlights.push(highlight);
                  return true;
                }
                return false;
              });
            }
          }
        }
      }
    }
    return hits;
  },

  // Generate language fallback and highlight options.
  getSearchOptions(fieldPrefix: string, lang: LocaleCode) {
    const langs = languages.getFallbacks(lang);
    if (lang !== 'en')
      langs.unshift(lang);

    // Searches both stemmed and non-stemmed version
    const fields = langs.map(currentLang => `${fieldPrefix}.${currentLang}*`);

    // Add search highlighters
    const highlight = {
      pre_tags: ['<span class="search-highlight">'],
      post_tags: ['</span>'],
      fields: {} as Record<string, Record<string, unknown>>
    };
    for (const currentLang of langs)
      highlight.fields[`${fieldPrefix}.${currentLang}*`] = {};

    return {
      fields,
      highlight
    };

  },

  // Get search suggestions based on entered characters for review subjects
  // (things).
  suggestThing(prefix = '', lang: LocaleCode = 'en'): Promise<SearchResponse<any>> {
    // We'll query all fallbacks back to English, and return all results
    const langs = languages.getFallbacks(lang);
    if (lang !== 'en')
      langs.unshift(lang);

    const query: SearchParams = {
      index: 'libreviews',
      body: {
        suggest: {}
      }
    };

    const suggest = (query.body?.suggest ?? {}) as Record<string, unknown>;

    for (const currentLanguage of langs) {
      suggest[`labels-${currentLanguage}`] = {
        prefix,
        completion: {
          field: `label.${currentLanguage}.completion`
        }
      };
    }

    query.body = { ...query.body, suggest };

    return getClient().search(query);
  },

  // Index a new review. Returns a promise; logs errors
  indexReview(review: Record<string, any>): Promise<unknown> {
    // Skip indexing if this is an old or deleted revision
    if (review._oldRevOf || review._revDeleted) {
      debug.util(`Skipping indexing of review ${review.id} - old or deleted revision`);
      return Promise.resolve();
    }

    // Note: The @types/elasticsearch package has outdated types that require
    // a 'type' parameter, but modern ES 7+ doesn't use (or accept) this parameter.
    // We use 'as unknown as' to bypass the incorrect type requirement.
    const params = {
      index: 'libreviews',
      id: review.id,
      routing: review.thingID,
      body: {
        createdOn: review.createdOn,
        title: mlString.stripHTML(review.title),
        text: mlString.stripHTML(review.html),
        starRating: review.starRating,
        type: 'review',
        joined: {
          name: 'review',
          parent: review.thingID
        }
      }
    } as unknown as IndexDocumentParams<Record<string, unknown>>;

    return getClient().index(params)
      .catch(error => debug.error({ error }));
  },

  // Index a new review subject (thing). Returns a promise; logs errors
  indexThing(thing: Record<string, any>): Promise<unknown> {
    // Skip indexing if this is an old or deleted revision
    if (thing._oldRevOf || thing._revDeleted) {
      debug.util(`Skipping indexing of thing ${thing.id} - old or deleted revision`);
      return Promise.resolve();
    }

    // Extract multilingual content from PostgreSQL JSONB structure
    // Access via virtual getters that map to metadata JSONB structure
    const description = thing.description;
    const subtitle = thing.subtitle;
    const authors = thing.authors;

    // Note: The @types/elasticsearch package has outdated types that require
    // a 'type' parameter, but modern ES 7+ doesn't use (or accept) this parameter.
    // We use 'as unknown as' to bypass the incorrect type requirement.
    const params = {
      index: 'libreviews',
      id: thing.id,
      body: {
        createdOn: thing.createdOn,
        label: mlString.stripHTML(thing.label),
        aliases: mlString.stripHTMLFromArray(thing.aliases),
        description: mlString.stripHTML(description),
        subtitle: mlString.stripHTML(subtitle),
        authors: mlString.stripHTMLFromArray(authors),
        joined: 'thing',
        type: 'thing',
        urls: thing.urls,
        urlID: thing.urlID
      }
    } as unknown as IndexDocumentParams<Record<string, unknown>>;

    return getClient().index(params)
      .catch(error => debug.error({ error }));
  },

  deleteThing(thing: { id: string }): Promise<unknown> {
    // Note: The @types/elasticsearch package requires 'type', but ES 7+ doesn't use it.
    const params = {
      index: 'libreviews',
      id: thing.id
    } as DeleteDocumentParams;
    return getClient().delete(params)
      .catch(error => debug.error({ error }));
  },

  deleteReview(review: { id: string }): Promise<unknown> {
    // Note: The @types/elasticsearch package requires 'type', but ES 7+ doesn't use it.
    const params = {
      index: 'libreviews',
      id: review.id
    } as DeleteDocumentParams;
    return getClient().delete(params)
      .catch(error => debug.error({ error }));
  },

  // Create the initial index for holding reviews and review subjects (things).
  // If index already exists, does nothing. Logs all other errors.
  createIndices(): Promise<void> {
    return getClient().indices.create({
      index: 'libreviews',
      body: {
        settings: {
          analysis: {
            tokenizer: {
              whitespace: {
                type: 'whitespace'
              }
            },
            analyzer: {
              label: {
                type: 'custom',
                tokenizer: 'whitespace',
                filter: ['trim', 'lowercase']
              }
            }
          }
        },
        mappings: {
          properties: {
            createdOn: {
              type: 'date'
            },
            joined: {
              type: 'join',
              relations: {
                thing: 'review'
              }
            },
            text: search.getMultilingualTextProperties(),
            title: search.getMultilingualTextProperties(),
            urls: search.getURLProperties(),
            label: search.getMultilingualTextProperties(true),
            aliases: search.getMultilingualTextProperties(true),
            description: search.getMultilingualTextProperties(),
            subtitle: search.getMultilingualTextProperties(),
            authors: search.getMultilingualTextProperties(),
            type: {
              type: 'keyword'
            }
          }
        }
      }
    })
      .catch(error => {
        if (/\[index_already_exists_exception\]/.test(String(error?.message ?? error)))
          return;
        debug.error({
          error
        });
      });
  },

  // Generate the mappings (ElasticSearch schemas) for indexing URLs. We index
  // each URL three times to enable multiple search strategies
  getURLProperties() {
    return {
      // https://www.wikidata.org/wiki/Q27940587 -> https,www.wikidata.org,wiki,q27940587
      type: 'text',
      fields: {
        raw: {
          type: 'keyword' // https://www.wikidata.org/wiki/Q27940587 -> https://www.wikidata.org/wiki/Q27940587
        },
        simple: {
          type: 'text',
          analyzer: 'simple' // https,www,wikidata,org,wiki,q
        }
      }
    };
  },

  // Generate the mappings (ElasticSearch schemas) for indexing multilingual
  // strings
  getMultilingualTextProperties(completionMapping = false) {
    const obj: { properties: Record<string, any> } = {
      properties: {}
    };

    const validLangs = languages.getValidLanguagesAndUndetermined();

    // We add all analyzers for all languages ElasticSearch has stemming support
    // for to the index, even if they're not yet supported by lib.reviews, so
    // we don't have to keep updating the index. Languages without analyzers
    // will be processed by the 'standard' analyzer (no stemming)
    for (const lang of Object.keys(analyzers)) {

      // Splice from language array so we can process remaining languages differently
      const langPos = validLangs.indexOf(lang as LocaleCode | 'und');
      if (langPos !== -1)
        validLangs.splice(langPos, 1);

      obj.properties[lang] = {
        type: 'text',
        index_options: 'offsets', // for sentence-based highlighting
        fields: {
          // The 'processed' property of the text field contains the stemmed
          // version (run through appropriate language analyzer) so we can
          // run searches against both the full text and the stemmed version,
          // as appropriate
          processed: {
            type: 'text',
            analyzer: analyzers[lang],
            index_options: 'offsets' // for sentence-based highlighting
          }
        }
      };
      if (completionMapping)
        obj.properties[lang].fields.completion = search.getCompletionMapping();
    }

    // Add remaining languages so we can do completion & offsets for those
    // as well.
    for (const lang of validLangs) {
      obj.properties[lang] = {
        type: 'text',
        index_options: 'offsets', // for sentence-based highlighting
      };
      if (completionMapping)
        obj.properties[lang].fields = {
          completion: search.getCompletionMapping()
        };
    }

    return obj;
  },

  // Return mapping for label autocompletion
  getCompletionMapping() {
    return {
      type: 'completion',
      analyzer: 'label',
      max_input_length: 256 // default is 50, our labels are 256
    };

  },

  close(): void {
    if (client && typeof (client as { close?: () => void }).close === 'function')
      client.close();
    client = null;
  },

};

export { search };
export default search;
