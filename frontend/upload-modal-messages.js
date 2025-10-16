const msgArr = [
  'select file',
  'start upload',
  'upload and insert media',
  'enter description',
  'my own work',
  'someone else\'s work',
  'someone else\'s work specified',
  'creator',
  'enter creator name',
  'enter source',
  'source',
  'license',
  'select license',
  'ok',
  'cancel',
  'fair use short',
  'cc-0 short',
  'cc-by short',
  'cc-by-sa short',
  'please enter description',
  'please specify rights',
  'could not complete action'
];

module.exports.getUploadModalMessageKeys = () => msgArr.slice();
