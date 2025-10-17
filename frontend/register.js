import $ from './lib/jquery.js';

const $username = $('#username');

if ($username.length) {
  $username.change(checkIllegalCharacters);
  $username.change(checkExistence);
}

function checkExistence() {

  // Abort if username is not valid
  if ($('#username-characters-error:visible').length) {
    $('#username-exists-error').hide();
    return;
  }

  let name = encodeURIComponent(this.value.trim());
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

function checkIllegalCharacters() {
  let regex = new RegExp(window.config.illegalUsernameCharacters);
  if (regex.test(this.value))
    $('#username-characters-error').show();
  else
    $('#username-characters-error').hide();
}
