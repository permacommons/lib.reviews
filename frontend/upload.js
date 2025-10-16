/* global $ */
import { msg } from './libreviews.js';

(function() {
  'use strict';
  let originalLabel = $('#upload-label').text();
  // We shouldn't be able to start an upload until we've selected some files.
  $('#start-upload').prop('disabled', true);
  $('#upload-input').change(() => {
    let files = $('#upload-input')[0].files;
    let count = files.length;
    let names = getNames(files);
    if (!count) {
      $('#start-upload').prop('disabled', true);
      $('#upload-label').text(originalLabel);
      $('#file-name-container').empty();
    } else {
      let countLabel = count == 1 ?
        msg('one file selected') :
        msg('files selected', { stringParam: count });
      // We use a different icon to represent multiple files
      if (count == 1)
        $('#upload-icon').removeClass('fa-files-o').addClass('fa-file-image-o');
      else
        $('#upload-icon').removeClass('fa-file-image-o').addClass('fa-files-o');
      $('#upload-label-text').text(countLabel);
      $('#start-upload').prop('disabled', false);
      $('#file-name-container').text(names.join(', '));
    }
  });

  function getNames(fileList) {
    let names = [];
    for (let i = 0; i < fileList.length; i++)
      names.push(fileList[i].name);
    return names;
  }
}());
