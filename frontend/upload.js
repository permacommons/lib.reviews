import $ from './lib/jquery.js';
import { msg } from './libreviews.js';

const $uploadInput = $('#upload-input');
const $startUpload = $('#start-upload');
const $uploadLabel = $('#upload-label');
const $uploadLabelText = $('#upload-label-text');
const $uploadIcon = $('#upload-icon');
const $fileNameContainer = $('#file-name-container');

if ($uploadInput.length && $startUpload.length) {
  const originalLabel = $uploadLabel.text();

  // We shouldn't be able to start an upload until we've selected some files.
  $startUpload.prop('disabled', true);
  $uploadInput.change(() => {
    const files = $uploadInput[0]?.files || [];
    const count = files.length;
    const names = getNames(files);
    if (!count) {
      $startUpload.prop('disabled', true);
      $uploadLabel.text(originalLabel);
      $fileNameContainer.empty();
    } else {
      const countLabel = count == 1 ?
        msg('one file selected') :
        msg('files selected', { stringParam: count });
      // We use a different icon to represent multiple files
      if (count == 1)
        $uploadIcon.removeClass('fa-files-o').addClass('fa-file-image-o');
      else
        $uploadIcon.removeClass('fa-file-image-o').addClass('fa-files-o');
      $uploadLabelText.text(countLabel);
      $startUpload.prop('disabled', false);
      $fileNameContainer.text(names.join(', '));
    }
  });
}

function getNames(fileList) {
  let names = [];
  for (let i = 0; i < fileList.length; i++)
    names.push(fileList[i].name);
  return names;
}
