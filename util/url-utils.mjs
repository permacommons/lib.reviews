/**
 * Because many sites generate multiple URLs or URL variants pointing to the
 * same resource, we standardize user-submitted URLs before storing or querying
 * them. This reduces the need for manual merging.
 *
 * This module also can tag some known URLs according to predefined tags like
 * 'shops' and 'reviews'.
 *
 * @namespace URLUtils
 */
import { parse as parseUrl } from 'node:url';

const urlRegex = /^(https?|ftp):\/\/(((([a-z]|\d|-|\.|_|~|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])|(%[\da-f]{2})|[!$&'()*+,;=]|:)*@)?(((\d|[1-9]\d|1\d\d|2[0-4]\d|25[0-5])\.(\d|[1-9]\d|1\d\d|2[0-4]\d|25[0-5])\.(\d|[1-9]\d|1\d\d|2[0-4]\d|25[0-5])\.(\d|[1-9]\d|1\d\d|2[0-4]\d|25[0-5]))|((([a-z]|\d|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])|(([a-z]|\d|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])([a-z]|\d|-|\.|_|~|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])*([a-z]|\d|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])))\.)+(([a-z]|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])|(([a-z]|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])([a-z]|\d|-|\.|_|~|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])*([a-z]|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])))\.?)(:\d*)?)(\/((([a-z]|\d|-|\.|_|~|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])|(%[\da-f]{2})|[!$&'()*+,;=]|:|@)+(\/(([a-z]|\d|-|\.|_|~|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])|(%[\da-f]{2})|[!$&'()*+,;=]|:|@)*)*)?)?(\?((([a-z]|\d|-|\.|_|~|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])|(%[\da-f]{2})|[!$&'()*+,;=]|:|@)|[\uE000-\uF8FF]|\/|\?)*)?(#((([a-z]|\d|-|\.|_|~|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])|(%[\da-f]{2})|[!$&'()*+,;=]|:|@)|\/|\?)*)*$/i;


// host: match against the hostname part of the URL
// converter: conversion to be applied to a URL of this type before it is added
//   to the database. Can be an array of multiple functions run in sequence.
// tags: internal descriptors that identify this URL, which can be used to group
//   related URLs. For applications that only use one tag, the first tag in the
//   array is chosen.
// id: identifier for all URLs of this type, which can be used to create
//  a default non-alphabetic presentation order all known URLs of a certain type
const rules = [{
    host: /^(www\.)?amazon\.com$/,
    converter: _stripAmazonQueryStrings,
    tags: ['shops', 'reviews'],
    id: 'amazon'
  },
  {
    host: /^(www\.)?wikidata\.org$/,
    tags: ['databases', 'opendata'],
    id: 'wikidata',
    converter: _stripFragment
  },
  {
    host: /^(www\.)?goodreads\.com$/,
    tags: ['reviews', 'databases'],
    id: 'goodreads'
  },
  {
    host: /^(www\.)?openstreetmap\.org$/,
    tags: ['maps', 'opendata', 'databases'],
    id: 'openstreetmap'
  },
  {
    host: /^openlibrary\.org$/,
    tags: ['databases', 'opendata'],
    id: 'openlibrary',
    converter: _stripOpenLibraryTitleSuffix
  },
  {
    host: /^(www\.)?imdb\.com$/,
    tags: ['databases', 'reviews'],
    id: 'imdb'
  },
  {
    host: /^(www\.)?yelp\.com$/,
    tags: ['reviews', 'databases'],
    id: 'yelp'
  },
  {
    host: /^(www\.)?tripadvisor\.com$/,
    tags: ['reviews', 'databases'],
    id: 'tripadvisor'
  },
  {
    host: /^(www\.)?indiebound\.org$/,
    tags: ['shops'],
    id: 'indiebound'
  },
  {
    host: /^([a-z]*)?wikipedia\.org$/,
    tags: ['summaries', 'databases', 'opendata'],
    id: 'wikipedia'
  },
  {
    host: /^store\.steampowered\.com$/,
    tags: ['shops', 'reviews'],
    id: 'steam'
  },
  {
    host: /^(.*\.)?itch\.io$/,
    tags: ['shops'],
    id: 'itch'
  },
  {
    host: /^(www\.)?gog\.com$/,
    tags: ['shops'],
    id: 'gog'
  },
];

// Preferred order. We generally rank open data before proprietary data, and
// nonprofit platforms before for-profit ones.
const placement = {
  databases: ['wikidata', 'imdb'],
  maps: ['openstreetmap'],
  reviews: ['yelp', 'tripadvisor', 'goodreads'],
  shops: ['indiebound', 'itch', 'gog', 'steam', 'amazon'],
  summaries: ['wikipedia']
};


const urlUtils = {

  validate(inputURL) {
    return urlRegex.test(inputURL);
  },

  // Apply all relevant converters. Since the URL is parsed via url.parse,
  // special characters are also urlencoded.
  normalize(inputURL) {
    let outputURL;
    const parsedURL = parseUrl(inputURL);
    if (!parsedURL)
      return inputURL;

    // Normalizes trailing slashes
    outputURL = parsedURL.href;

    const runAll = (converters, url) => {
      converters.forEach(converter => (url = converter(url)));
      return url;
    };

    for (let rule of rules) {
      if (rule.converter && rule.host.test(parsedURL.hostname)) {
        if (Array.isArray(rule.converter))
          outputURL = runAll(rule.converter, outputURL);
        else
          outputURL = rule.converter(outputURL);
      }
    }

    return outputURL;

  },

  // Transforms an URL array into a key value object as follows:
  //
  // {
  //   databases:  [{ id: 'wikidata', url: 'https://www.wikidata.org/wiki/Q2611788' }],
  //   reviews: [{ id: 'yelp', url: 'https://www.yelp.com/biz/katzs-delicatessen-new-york'],
  //   opendata: [{ id: 'wikidata', url: 'https://www.wikidata.org/wiki/Q2611788' }],
  //   other: ['https://www.katzsdelicatessen.com/']
  //  }
  //
  // If onlyOneTag is set to true, the first tag from the rules is applied.
  // If sortResults is set to true, the placement rules are applied.
  getURLsByTag(inputURLs = [], options = { onlyOneTag: false, sortResults: false }) {

    const { onlyOneTag, sortResults } = options;
    const rv = {};
    for (let inputURL of inputURLs) {
      let recognized = false;
      const parsedURL = parseUrl(inputURL);
      if (!parsedURL)
        continue;
      for (let rule of rules) {
        if (rule.host.test(parsedURL.hostname) && rule.tags && rule.id) {
          for (let tag of rule.tags) {
            if (rv[tag] === undefined)
              rv[tag] = [];
            rv[tag].push({ id: rule.id, url: inputURL });
            recognized = true;
            if (onlyOneTag)
              break;
          }
        }
      }

      // Sort surces in each tag using placement array, provided it's
      // configured for this tag
      if (sortResults) {
        for (let tag in rv) {
          if (Array.isArray(placement[tag]))
            rv[tag].sort((obj1, obj2) => {
              // Look up source IDs in the placement array
              let p1 = placement[tag].indexOf(obj1.id);
              let p2 = placement[tag].indexOf(obj2.id);

              // For legibility
              let p1Found = p1 != -1;
              let p2Found = p2 != -1;

              // A return value of -1 means p1 wins (is earlier in the result
              // array); a return value of 1 means p2 wins.
              //
              // If one of the two isn't found in the placement array at all,
              // the other wins. Otherwise, being later in the placement array
              // means being later in the result array.
              if (p1 > p2)
                return !p2Found ? -1 : 1;
              else if (p1 < p2)
                return !p1Found ? 1 : -1;
              else
                return 0; // We don't care
            });
        }
      }
      if (!recognized) {
        if (rv.other === undefined)
          rv.other = [];
        rv.other.push({ id: 'unknown', url: inputURL });
      }
    }
    return rv;
  },

  prettify(inputURL) {
    return inputURL
      .replace(/^.*?:\/\//, '') // strip protocol
      .replace(/\/$/, ''); // remove trailing slashes
  }

};


/**
 * Open Library "work" and "edition" URLs contain a human-readable string at
 * the end, derived from the title. This string is optional, and it causes
 * problems matching URLs against each other, so we remove it.
 *
 * @param {String} inputURL
 *  the Open Library URL
 * @returns {String}
 *  canonicalized URL
 * @memberof URLUtils
 * @protected
 */
function _stripOpenLibraryTitleSuffix(inputURL) {
  let match = inputURL.match(new RegExp('^https*://openlibrary.org/(works|books)/(OL[^/]+)/*(.*)$', 'i'));
  if (match === null)
    return inputURL;
  else
    return `https://openlibrary.org/${match[1]}/${match[2]}`;
}

function _stripAmazonQueryStrings(inputURL) {
  let regex = /(.*\/)ref=.*$/;
  let match = inputURL.match(regex);
  if (Array.isArray(match) && match[1])
    return match[1];
  else
    return inputURL;
}

/**
 * Generic converter to discard the fragment portion of an input URL. This can
 * be useful for sites where fragments are frequently used and likely to be part
 * of the URL a user copies into the clipboard.
 *
 * @param {String} inputURL
 *  any URL
 * @returns {String}
 *  URL without fragment
 * @memberof URLUtils
 * @protected
 */
function _stripFragment(inputURL) {
  return inputURL.split('#')[0];
}

export default urlUtils;
