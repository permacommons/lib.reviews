import $ from './lib/jquery.js';

export type UsernameInput = JQuery<HTMLInputElement>;

declare global {
  interface Window {
    config: {
      illegalUsernameCharacters: string;
      language: string;
    };
  }
}

const $username: UsernameInput = $('#username');

if ($username.length) {
  attachUsernameValidation($username);
}

/**
 * Attaches username validation listeners to the registration form input.
 *
 * @param usernameInput - jQuery handle for the username input field.
 */
export function attachUsernameValidation(usernameInput: UsernameInput): void {
  usernameInput.on('change', checkIllegalCharacters);
  usernameInput.on('change', checkExistence);
}

/**
 * Displays the "username exists" warning by issuing a `HEAD` request to the
 * user lookup endpoint.
 *
 * jQuery binds the current input element as `this` when the handler runs.
 */
function checkExistence(this: HTMLInputElement) {
  if ($('#username-characters-error:visible').length) {
    $('#username-exists-error').hide();
    return;
  }

  const name = encodeURIComponent(this.value.trim());

  $.ajax({
    type: 'HEAD',
    url: `/api/user/${name}`
  })
    .done(() => {
      $('#username-exists-error').show();
    })
    .fail(() => {
      $('#username-exists-error').hide();
    });
}

/**
 * Toggles the illegal character warning when the username fails validation.
 *
 * jQuery binds the current input element as `this` when the handler runs.
 */
function checkIllegalCharacters(this: HTMLInputElement) {
  const regex = new RegExp(window.config.illegalUsernameCharacters);
  if (regex.test(this.value))
    $('#username-characters-error').show();
  else
    $('#username-characters-error').hide();
}
