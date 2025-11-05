import $ from './lib/jquery.js';

const $bioTextarea: JQuery<HTMLTextAreaElement> = $('#bio-textarea');

if ($bioTextarea.length) {
  $bioTextarea.keyup(updateCharacterCount);
  updateCharacterCount();
}

function updateCharacterCount(): void {
  const $counter: JQuery<HTMLElement> = $('#character-counter');
  const $warning: JQuery<HTMLElement> = $('#over-maximum-warning');
  const $overMaximumCount: JQuery<HTMLElement> = $('#over-maximum-count');

  const count = String($bioTextarea.val() ?? '').length;
  const remaining = 1000 - count;

  if (remaining > 0) {
    $counter.show();
    $warning.hide();
    $('#character-count').text(String(remaining));
  } else if (remaining === 0) {
    $counter.hide();
    $warning.hide();
  } else {
    $counter.hide();
    $warning.show();
    $overMaximumCount.text(String(-1 * remaining));
  }
}
