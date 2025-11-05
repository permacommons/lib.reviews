/* External deps */
import config from 'config';
import escapeHTML from 'escape-html';
import debug from '../util/debug.ts';
import { fetchJSON } from '../util/http.ts';

/* Internal deps */
import AbstractBackendAdapter, {
  type AdapterLookupResult,
  type AdapterMultilingualString,
} from './abstract-backend-adapter.ts';
import languages from '../locales/languages.ts';

/**
 * How lib.reviews language codes translate to Wikidata language codes.
 * Since Wikidata supports a superset of languages and most language codes
 * are identical, we only enumerate exceptions.
 */
const nativeToWikidata: Record<string, string> = {
  pt: 'pt-br',
  'pt-PT': 'pt',
};

const apiBaseURL = 'https://www.wikidata.org/w/api.php';

interface WikidataLabeledValue {
  language: string;
  value: string;
}

type WikidataStringMap = Record<string, WikidataLabeledValue | undefined>;

interface WikidataEntity {
  labels?: WikidataStringMap;
  descriptions?: WikidataStringMap;
}

interface WikidataResponse {
  success?: number | boolean;
  entities?: Record<string, WikidataEntity | undefined>;
}

export default class WikidataBackendAdapter extends AbstractBackendAdapter {
  constructor() {
    super();
    this.supportedPattern = new RegExp(
      '^http(s)*://(www.)*wikidata.org/(entity|wiki)/(Q\\d+)(?:#.*)?$',
      'i'
    );
    this.supportedFields = ['label', 'description'];
    this.sourceID = 'wikidata';
    this.sourceURL = 'https://www.wikidata.org/';
  }

  async lookup(url: string): Promise<AdapterLookupResult> {
    let qNumber = (url.match(this.supportedPattern) || [])[4];
    if (!qNumber)
      throw new Error(
        'URL does not appear to contain a Q number (e.g., Q42) or is not a Wikidata URL.'
      );

    // in case the URL had a lower case "q"
    qNumber = qNumber.toUpperCase();

    // Not we don't specify fallback, so we won't get results for languages
    // that don't have content
    const urlWithParams = new URL(apiBaseURL);
    urlWithParams.search = new URLSearchParams({
      action: 'wbgetentities',
      format: 'json',
      languages: this.getAcceptedWikidataLanguageList(),
      props: 'labels|descriptions',
      ids: qNumber,
    }).toString();

    const data = await fetchJSON<WikidataResponse>(urlWithParams, {
      timeout: config.adapterTimeout,
      label: 'Wikidata',
      headers: {
        'User-Agent': config.adapterUserAgent,
      },
    });
    debug.adapters('Received data from Wikidata adapter:\\n' + JSON.stringify(data, null, 2));

    if (typeof data !== 'object' || !data.success || !data.entities || !data.entities[qNumber])
      throw new Error('Did not get a valid Wikidata entity for query: ' + qNumber);

    const entity = data.entities[qNumber] as WikidataEntity;

    // Descriptions result will be an empty object if no description is available, so
    // will always pass this test
    if (!entity.labels || !entity.descriptions)
      throw new Error('Did not get label and description information for query: ' + qNumber);

    // Get multilingual string for descriptions and entities
    const description = this.convertToMlString(entity.descriptions, 256);
    const label = this.convertToMlString(entity.labels, 512);

    if (!Object.keys(label).length)
      throw new Error('Did not get a label for ' + qNumber + ' in any supported language.');

    return {
      data: {
        label,
        description,
      },
      sourceID: this.sourceID,
    };
  }

  /**
   * Convert a Wikidata string object to a lib.reviews multilingual string.
   * They are similar, but language codes differ, and Wikidata nests
   * one level deeper in order to sometimes convey that a string
   * represents a fallback for another language.
   *
   * Wikidata strings may also contain unescaped special characters,
   * while ml-strings may not, and we impose a maximum length if provided
   * (applied to the escaped length).
   */
  convertToMlString(wdObj: WikidataStringMap, maxLength?: number): AdapterMultilingualString {
    const mlStr: AdapterMultilingualString = {};
    for (const language of Object.keys(wdObj)) {
      const native = this.getNativeLanguageCode(language);
      // Can't handle this language in lib.reviews, ignore
      if (native === null) continue;

      const entry = wdObj[language];
      if (entry && typeof entry === 'object' && entry.language === language && entry.value) {
        let wdStr = escapeHTML(entry.value);
        if (typeof maxLength === 'number') wdStr = wdStr.substr(0, maxLength);
        mlStr[native] = escapeHTML(wdStr);
      }
    }
    return mlStr;
  }

  /** Return the Wikimedia code for a lib.reviews language code */
  getWikidataLanguageCode(language: string): string {
    const code = nativeToWikidata[language] || language;
    // WMF codes are consistently lower case
    return code.toLowerCase();
  }

  /**
   * Return the native code for a Wikidata language code. Returns null if
   * not a valid native language.
   */
  getNativeLanguageCode(language: string): string | null {
    for (const k in nativeToWikidata) {
      if (nativeToWikidata[k].toUpperCase() === language.toUpperCase()) return k;
    }
    return languages.isValid(language) ? language : null;
  }

  /** Return array of the codes we can handle */
  getAcceptedWikidataLanguageCodes(): string[] {
    return languages.getValidLanguages().map(language => this.getWikidataLanguageCode(language));
  }

  /** Return codes in list format expected by API */
  getAcceptedWikidataLanguageList(): string {
    return this.getAcceptedWikidataLanguageCodes().join('|');
  }
}
