/**
 * Page-specific functionality for the manage account requests page.
 */

const rejectionForms = document.querySelectorAll('.rejection-form');

if (rejectionForms.length > 0) {
  // Initialize rejection forms - hide them initially (JS-enabled only)
  rejectionForms.forEach(form => {
    form.classList.add('hidden');
  });

  // Show rejection form
  document.querySelectorAll('.reject-button').forEach(button => {
    button.addEventListener('click', function () {
      const requestId = (this as HTMLElement).dataset.requestId;
      if (!requestId) return;

      const rejectionForm = document.getElementById(`rejection-${requestId}`);
      const actionGroup = (this as HTMLElement).closest('.action-group');
      if (rejectionForm) rejectionForm.classList.remove('hidden');
      if (actionGroup) actionGroup.classList.add('hidden');
    });
  });

  // Cancel rejection
  document.querySelectorAll('.cancel-reject').forEach(button => {
    button.addEventListener('click', function () {
      const requestId = (this as HTMLElement).dataset.requestId;
      if (!requestId) return;

      const rejectionForm = document.getElementById(`rejection-${requestId}`);
      const form = (this as HTMLElement).closest('form');
      if (rejectionForm) rejectionForm.classList.add('hidden');
      if (form) {
        const actionGroup = form.querySelector('.action-group');
        if (actionGroup) actionGroup.classList.remove('hidden');
      }
    });
  });
}
