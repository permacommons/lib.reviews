import $ from './lib/jquery.js';

const $bioTextarea = $('#bio-textarea');

if ($bioTextarea.length) {
  $bioTextarea.keyup(updateCharacterCount);
  updateCharacterCount();
}

function updateCharacterCount() {
  const $counter = $('#character-counter');
  const $warning = $('#over-maximum-warning');
  const $overMaximumCount = $('#over-maximum-count');
  const count = $bioTextarea.val().length;
  const remaining = 1000 - count;
  if (remaining > 0) {
    $counter.show();
    $warning.hide();
    $('#character-count').text(remaining);
  } else if (remaining === 0) {
    $counter.hide();
    $warning.hide();
  } else {
    $counter.hide();
    $warning.show();
    $overMaximumCount.text(-1 * remaining);
  }
}
