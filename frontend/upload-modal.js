/* global $, libreviews, config */
'use strict';

/**
 * Creates an overlay modal dialog which lets the user upload a single file via
 * the upload API.
 *
 * @param {Function} [successCallback]
 *  Callback to run after a successful upload.
 * @param {Function} [errorCallback]
 *  Callback to run after a failed upload (does not run if modal is closed).
 */
export function uploadModal(successCallback, errorCallback) {
  // Obtain template for the dialog (a simple jQuery object).
  const $modal = getTemplate();

  $('body').append($modal);

  // Initially the modal just shows the upload button; once a file is selected,
  // we expand to show the metadata form
  $('#upload-input').change(expandModal);

  // If the user selects "Someone else's work", we flip to the second page to
  // let them enter author/source information
  $('#upload-modal-other').click(showPage2);

  // If the user selects "My own work", we set all metadata back to the default
  // values
  $('#upload-modal-ownwork').click(resetMetadata);

  $('#upload-modal-description').blur(libreviews.trimInput);

  // If the user clicks "Cancel" on page 2, we flip back to page 1, and we
  // de-select the radio buttons unless we have complete data from a previous
  // "OK" action
  $('#upload-modal-cancel-metadata').click(cancelPage2);

  // When the user clicks "Start upload", we first perform some manual
  // "required" checks - we don't use our standard library here to keep the
  // modal's UI compact (the "*" indicators would take up additional space).
  //
  // we send all the data to the upload API, which may return multiple errors.
  // Predictable errors (bad file type, actual MIME type doesn't match claimed
  // MIME type) will be reported to the user. Unknown errors will fall back to a
  // generic error message.
  //
  // Once the operation succeeds or fails, the respective callbacks are run.
  $('#upload-modal-start-upload').click(function(event) {
    event.preventDefault();
    startUpload(successCallback, errorCallback);
  });

  // We use our standard validation library for the page 2 metadata form. If it
  // reports no errors, the confirmMetadata callback updates the hidden fields
  // in the form on page 1.
  $('#upload-modal-confirm-metadata').attachRequiredFieldHandler({
    formSelector: '#upload-metadata-form',
    callback: confirmMetadata
  });

  // Open the modal dialog
  $modal.modal();

  // Lock in the inputs so user can tab through them but not exit the modal
  $modal.lockTab();

  // Clean up on each close
  $('#upload-modal').on($.modal.BEFORE_CLOSE, function() {
    $modal.remove();
  });

}


const
  __ = libreviews.msg,
  msg = {
    head: __('upload and insert media'),
    select: __('select file'),
    start: __('start upload'),
    placeholder: {
      description: __('enter description'),
      creator: __('enter creator name'),
      source: __('enter source'),
      license: __('select license')
    },
    creator: __('creator'),
    ownwork: __('my own work'),
    other: __('someone else\'s work'),
    specified: __('someone else\'s work specified'),
    source: __('source'),
    license: __('license'),
    licenses: {
      'fair-use': __('fair use short'),
      'cc-0': __('cc-0 short'),
      'cc-by': __('cc-by short'),
      'cc-by-sa': __('cc-by-sa short')
    },
    required: {
      rights: __('please specify rights'),
      description: __('please enter description')
    },
    ok: __('ok'),
    cancel: __('cancel'),
    error: __('could not complete action')
  },

  getTemplate = () => $(
    `<div id="upload-modal" class="hidden-regular">
<form class="pure-form" id="upload-modal-form">
<div id="upload-modal-page-1">
<div class="upload-modal-buttondiv">
<h3>${msg.head}</h3>
<input type="file" name="files" id="upload-input" accept="image/*,video/webm,video/ogg,audio/*" class="hidden">
<label id="upload-modal-label" for="upload-input" data-upload-count class="pure-button button-rounded" tabindex="0" data-focusable>
<span class="fa fa-fw fa-file-image-o spaced-icon" id="upload-icon">&nbsp;</span><span id="upload-label-text">${msg.select}</span></label>
</div>
<div id="upload-modal-page-1-expansion" class="hidden-regular">
<p>
<textarea id="upload-modal-description" name="description" class="pure-input-1" placeholder="${msg.placeholder.description}"></textarea>
<p>
<table>
<tr class="input-row">
<td><input type="radio" id="upload-modal-ownwork" name="ownwork" value="1"></td>
<td><label for="upload-modal-ownwork" class="inline-label">${msg.ownwork}</label></td>
</tr>
<tr class="input-row">
<td>
<input type="radio" id="upload-modal-other" name="ownwork" value=""></td>
<td><label for="upload-modal-other" class="inline-label" id="upload-modal-other-label">${msg.other}</label></td>
</tr>
</table>
<input type="hidden" name="language" value="${config.language}">
<input type="hidden" id="upload-modal-license" name="license" value="cc-by-sa">
<input type="hidden" id="upload-modal-creator" name="creator" value="">
<input type="hidden" id="upload-modal-source" name="source" value="">
<p>
<div id="upload-modal-need-description" class="upload-modal-error error hidden-regular">${msg.required.description}</div>
<div id="upload-modal-need-rights" class="upload-modal-error error hidden-regular">${msg.required.rights}</div>
<div class="upload-modal-buttondiv">
<button id="upload-modal-start-upload" disabled class="pure-button pure-button-primary button-rounded" type="submit"><span class="fa fa-fw fa-cloud-upload spaced-icon">&nbsp;</span>${msg.start}</button><span id="upload-modal-spinner" class="fa fa-spinner fa-spin hidden-regular"></span>
</div>
<div class="error" id="upload-errors"></div>
</div>
</form>
</div>
<div id="upload-modal-page-2" class="hidden-regular">
<span id="upload-modal-cancel-metadata"><span class="fa fa-chevron-left fa-fw">&nbsp;</span> ${msg.cancel}
</span>
<p>
<p>
<form id="upload-metadata-form" class="pure-form">
<label for="upload-metadata-creator">${msg.creator}<span class="required"> *</span></label><br>
<input id="upload-metadata-creator" data-required type="text" class="pure-input-1" placeholder="${msg.placeholder.creator}">
<p>
<label for="upload-metadata-source">${msg.source}<span class="required"> *</span></label><br>
<input id="upload-metadata-source" data-required type="text" class="pure-input-1" name="source" placeholder="${msg.placeholder.source}">
<p>
<label for="upload-metadata-license">${msg.license}<span class="required"> *</span></label><br>
<select id="upload-metadata-license" data-required class="pure-input-1" name="license">
<option value="" disabled selected>${msg.placeholder.license}</option>
<option value="fair-use">${msg.licenses['fair-use']}</option>
<option value="cc-0">${msg.licenses['cc-0']}</option>
<option value="cc-by">${msg.licenses['cc-by']}</option>
<option value="cc-by-sa">${msg.licenses['cc-by-sa']}</option>
</select>
<p>
<button id="upload-modal-confirm-metadata" data-check-required class="pure-button pure-button-primary button-rounded">
${msg.ok}
</button>
</form>
</div>
</div>`
  ),

  enableSpinner = () => $('#upload-modal-spinner').removeClass('hidden-regular'),
  disableSpinner = () => $('#upload-modal-spinner').addClass('hidden-regular'),
  enableUpload = () => $('#upload-modal-start-upload').prop('disabled', false),
  disableUpload = () => $('#upload-modal-start-upload').prop('disabled', true);

function expandModal() {
  let files = $('#upload-input')[0].files;
  $('#upload-label-text').text(files[0].name);
  enableUpload();
  $('#upload-modal-page-1-expansion').slideDown(200);
  $('#upload-modal-description').focus();
}


function showPage2() {
  $('#upload-modal-page-1').hide(200);
  $('#upload-modal-page-2').show(200);
  $('#upload-metadata-creator').focus();
}

function resetMetadata() {
  $('#upload-modal-license').val('cc-by-sa');
  $('#upload-modal-source').val('');
  $('#upload-modal-creator').val('');
}

function cancelPage2() {
  $('#upload-modal-page-2').hide(200);
  $('#upload-modal-page-1').show(200);

  // Reset radio selection in case we don't have all the required data
  if (!$('#upload-modal-license').val() || !$('#upload-modal-creator').val() ||
    !$('#upload-modal-source').val())
    $('#upload-modal-other').prop('checked', false);
}

function startUpload(successCallback, errorCallback) {

  const hasDescription = Boolean($('#upload-modal-description').val());
  const hasRights = $('#upload-modal-ownwork').prop('checked') ||
    $('#upload-modal-other').prop('checked');

  $('#upload-modal-need-description').toggle(!hasDescription);
  $('#upload-modal-need-rights').toggle(!hasRights);

  if (!hasDescription || !hasRights)
    return;

  const form = $('#upload-modal-form')[0];
  const data = new FormData(form);
  enableSpinner();
  disableUpload();
  $('#upload-errors').empty();
  $.ajax({
      url: '/api/actions/upload',
      data,
      cache: false,
      contentType: false,
      processData: false,
      type: 'POST',
    })
    .done(data => {
      disableSpinner();
      $.modal.close();
      if (successCallback)
        successCallback(data.uploads);
    })
    .fail(data => {
      const errorArray = [];
      disableSpinner();
      enableUpload();
      let showGenericError = true;

      if (data && data.responseJSON && data.responseJSON.errors) {
        errorArray.push(data.responseJSON.errors);
        let allErrors = '';
        for (let error of data.responseJSON.errors) {
          if (error.displayMessage) {
            allErrors += error.displayMessage + '<br>';
            showGenericError = false;
          }
        }
        if (allErrors)
          $('#upload-errors').html(allErrors);
      } else {
        errorArray.push('Unknown error');
      }
      if (showGenericError)
        $('#upload-errors').html(msg.error);

      if (errorCallback)
        errorCallback(errorArray);
    });
}

function confirmMetadata(event) {
  const license = $('#upload-metadata-license').val(),
    source = $('#upload-metadata-source').val(),
    creator = $('#upload-metadata-creator').val();
  $('#upload-modal-license').val(license);
  $('#upload-modal-source').val(source);
  $('#upload-modal-creator').val(creator);
  const info = `
${msg.specified}<br>
<table id="upload-modal-metadata-info">
<tr><td><b>${msg.creator}</b></td><td>${creator}</td></tr>
<tr><td><b>${msg.source}</b></td><td>${source}</td></tr>
<tr><td><b>${msg.license}</b></td><td>${msg.licenses[license]}</td></tr>
</table>
`;
  $('#upload-modal-other-label').html(info);
  $('#upload-modal-page-2').hide(200);
  $('#upload-modal-page-1').show(200);
  event.preventDefault();
}
