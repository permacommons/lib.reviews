import $ from './lib/jquery.js';
import { msg, validateURL, urlHasSupportedProtocol } from './libreviews.js';

// Front-end code for the /some-thing/manage/urls interface

// Initialize validation messages
$('[id^=url-validation-]').each(initializeValidationTemplate);

// Protocol helpers
$('[data-add-protocol]').click(addProtocol);

// Combined validation handler
$('input[name^=url-]').change(handleURLValidation);

// Add new URL row to table
$('button#add-more').click(addNewURLRow);

function initializeValidationTemplate() {
  // data-url-input is used to mark inputs with URL validation
  let input = $(this).parent().find('input[data-url-input]')[0];
  // data-add-protocol-for is used to look up input element
  $(this).append(`<div class="validation-error">${msg('not a url')}</div>` +
    `<div class="helper-links"><a href="#" data-add-protocol="https://" data-add-protocol-for="${input.name}">` +
    `${msg('add https')}</a> &ndash; <a href="#" data-add-protocol="http://"` +
    `data-add-protocol-for="${input.name}">${msg('add http')}</div>`);
}

function handleURLValidation() {
  let $parent = $(this).parent();
  let hasText = typeof this.value == 'string' && this.value.length > 0;
  let showValidationError = hasText && !validateURL(this.value);
  let showProtocolHelperLinks = hasText && !urlHasSupportedProtocol(this.value);
  $parent.find('.validation-error').toggle(showValidationError);
  $parent.find('.helper-links').toggle(showProtocolHelperLinks);
}

function addProtocol(e) {
  let protocol = $(this).attr('data-add-protocol');
  let inputName = $(this).attr('data-add-protocol-for');
  let $input = $(`input[name=${inputName}]`);
  $input.val(protocol + $input.val());
  $input.trigger('change');
  e.preventDefault();
}

function addNewURLRow(e) {

  // Will be count or NaN if something goes wrong
  let count = +(
    $('input[name^=url-]')
    .last()
    .attr('name')
    .match(/[0-9]+/) || []
  )[0];

  // We're adding a new row
  count++;

  if (!isNaN(count)) {
    let $newRow = $(`<tr valign="top"><td class="max-width">` +
        `<input name="url-${count}" data-url-input type="text" class="max-width" ` +
        `placeholder="${msg('enter web address short')}">` +
        `<div id="url-validation-${count}"></div></td>` +
        `<td><input type="radio" name="primary" value="${count}"></td></tr>`)
      .insertBefore('#add-more-row');

    // Wire new row up as above
    $newRow
      .find('[id^=url-validation-]')
      .each(initializeValidationTemplate);

    $newRow
      .find('[data-add-protocol]')
      .click(addProtocol);

    $newRow
      .find('input[name^=url-]')
      .change(handleURLValidation);

  }

  e.preventDefault();
}
