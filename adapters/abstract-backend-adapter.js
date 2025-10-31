// There is a corresponding abstract frontend class in the frontend/ directory.
// While similar, due to client/server differences and likely functional
// divergence, we are keeping these separate.
export default class AbstractBackendAdapter {

  constructor() {

    // Define in derived classes
    this.sourceID = undefined; // a short lower-case string, e.g., 'wikidata'
    this.sourceURL = undefined; // the most canonical URL for the source
    this.supportedPattern = undefined; // a RegExp object
    this.supportedFields = undefined; // array of 'thing' properties this adapter supports

    if (new.target === AbstractBackendAdapter)
      throw new TypeError('AbstractBackendAdapter is an abstract class, please instantiate a derived class.');
  }

  // Does this adapter support a given URL?
  ask(url) {
    return this.supportedPattern.test(url);
  }

  // Perform a lookup for a given URL. Return a promise that resolves
  // with an object on success, and rejects with an error (if any) on
  // failure. The object should take the form:
  //
  // {
  //   data: {
  //     label: 'String'  (required)
  //     description: 'String' (optional)
  //     thing: Thing model (optional, really only useful for native adapter)
  //   }
  // }
  async lookup(_url) {
    throw new Error('Not implemented.');
  }

  getSourceURL() {
    return this.sourceURL || 'no source URL defined';
  }

  getSourceID() {
    return this.sourceID || 'no source ID defined';
  }

  getSupportedFields() {
    return this.supportedFields || [];
  }

}
