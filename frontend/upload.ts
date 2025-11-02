import $ from './lib/jquery.js';
import { msg } from './libreviews.js';

const $uploadInput: JQuery<HTMLInputElement> = $('#upload-input');
const $startUpload: JQuery<HTMLButtonElement> = $('#start-upload');
const $uploadLabel: JQuery<HTMLLabelElement> = $('#upload-label');
const $uploadLabelText: JQuery<HTMLElement> = $('#upload-label-text');
const $uploadIcon: JQuery<HTMLElement> = $('#upload-icon');
const $fileNameContainer: JQuery<HTMLElement> = $('#file-name-container');

if ($uploadInput.length && $startUpload.length) {
  const originalLabel = $uploadLabel.text();

  $startUpload.prop('disabled', true);
  $uploadInput.change(() => {
    const files = ($uploadInput[0] as HTMLInputElement | undefined)?.files;
    const count = files?.length ?? 0;
    const names = files ? getNames(files) : [];
    if (!count) {
      $startUpload.prop('disabled', true);
      $uploadLabel.text(originalLabel);
      $fileNameContainer.empty();
    } else {
      const countLabel = count === 1
        ? msg('one file selected')
        : msg('files selected', { stringParam: count });

      // We use a different icon to represent multiple files
      if (count === 1)
        $uploadIcon.removeClass('fa-files-o').addClass('fa-file-image');
      else
        $uploadIcon.removeClass('fa-file-image').addClass('fa-files-o');

      $uploadLabelText.text(countLabel);
      $startUpload.prop('disabled', false);
      $fileNameContainer.text(names.join(', '));
    }
  });
}

/**
 * Get file names from a FileList.
 */
function getNames(fileList: FileList): string[] {
  return Array.from(fileList).map(f => f.name);
}