import $ from './lib/jquery.js';
import { msg, urlHasSupportedProtocol, validateURL } from './libreviews';

// Front-end code for the /some-thing/manage/urls interface

// Initialize validation messages
$('[id^=url-validation-]').each(initializeValidationTemplate);

// Protocol helpers
$('[data-add-protocol]').click(addProtocol);

// Combined validation handler
$('input[name="urls[]"]').change(handleURLValidation);

// Add new URL row to table
$('button#add-more').click(addNewURLRow);

function initializeValidationTemplate(this: HTMLElement): void {
  const input = $(this).parent().find('input[data-url-input]')[0] as HTMLInputElement | undefined;
  const inputName = input?.name ?? '';
  $(this).append(
    `<div class="validation-error">${msg('not a url')}</div>` +
      `<div class="helper-links"><a href="#" data-add-protocol="https://" data-add-protocol-for="${inputName}">` +
      `${msg('add https')}</a> &ndash; <a href="#" data-add-protocol="http://"` +
      `data-add-protocol-for="${inputName}">${msg('add http')}</div>`
  );
}

function handleURLValidation(this: HTMLInputElement): void {
  const $parent = $(this).parent();
  const value = this.value;
  const hasText = value.length > 0;
  const showValidationError = hasText && !validateURL(value);
  const showProtocolHelperLinks = hasText && !urlHasSupportedProtocol(value);
  $parent.find('.validation-error').toggle(showValidationError);
  $parent.find('.helper-links').toggle(showProtocolHelperLinks);
}

function addProtocol(this: HTMLElement, event: JQuery.Event): void {
  const protocol = String($(this).attr('data-add-protocol') ?? '');
  const $input = $(this).closest('td').find('input[data-url-input]');
  $input.val(protocol + String($input.val() ?? ''));
  $input.trigger('change');
  event.preventDefault();
}

function addNewURLRow(event: JQuery.Event): void {
  const count = $('input[data-url-input]').length;

  if (!Number.isNaN(count)) {
    const $newRow = $(
      `<tr valign="top"><td class="max-width">` +
        `<input name="urls[]" data-url-input type="text" class="max-width" ` +
        `placeholder="${msg('enter web address short')}">` +
        `<div id="url-validation-${count}"></div></td>` +
        `<td><input type="radio" name="primary" value="${count}"></td></tr>`
    ).insertBefore('#add-more-row');

    // Wire new row up as above
    $newRow.find('[id^=url-validation-]').each(initializeValidationTemplate);

    $newRow.find('[data-add-protocol]').click(addProtocol);

    $newRow.find('input[name="urls[]"]').change(handleURLValidation);
  }

  event.preventDefault();
}
