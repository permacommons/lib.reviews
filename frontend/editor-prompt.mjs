import $ from './lib/jquery.mjs';
import { msg } from './libreviews.mjs';

// Helper module for menu prompts. Derived from
// https://github.com/ProseMirror/prosemirror-example-setup/blob/master/src/prompt.js
const prefix = "ProseMirror-prompt";

export function openPrompt(spec) {
  // Spec: title (string), fields (object), view (EditorView), callback (function)

  // We want modal-like behavior, so we disable the active view
  spec.view.disable();

  let $rteContainer = $(spec.view.dom).parent().parent(),
    $wrapper = $('<div>').addClass(prefix).prependTo($rteContainer);

  // Close prompt
  function close() {
    $(window).off('mousedown', maybeClose);
    $wrapper.remove();
    spec.view.enable();
    spec.view.focus();
  }

  // Close prompt on outside clicks
  function maybeClose(event) {
    if (!$wrapper[0].contains(event.target))
      close();
  }

  setTimeout(() => $(window).on('mousedown', maybeClose), 50);

  let domFields = [];
  for (let name in spec.fields)
    domFields.push(spec.fields[name].render());

  let $submitButton = $('<button>')
    .attr('type', 'submit')
    .addClass(`${prefix}-submit pure-button pure-button-primary`)
    .text(msg('ok'));

  let $cancelButton = $('<button>')
    .attr('type', 'button')
    .addClass(`${prefix}-cancel pure-button`)
    .text(msg('cancel'));

  $cancelButton.click(close);

  let $form = $('<form>').appendTo($wrapper);
  if (spec.title)
    $('<h5>').text(spec.title).appendTo($form);

  domFields.forEach(field => $('<div>').append($(field)).appendTo($form));

  let $buttons = $('<div>')
    .addClass(`${prefix}-buttons`)
    .appendTo($form);
  $buttons.append($submitButton, ' ', $cancelButton);

  let dialogBox = $wrapper[0].getBoundingClientRect(),
    editorBox = $rteContainer[0].getBoundingClientRect(),
    centeredX = (editorBox.width / 2) - (dialogBox.width / 2),
    centeredY = (editorBox.height / 2) - (dialogBox.height / 2),
    left = centeredX + "px",
    top = centeredY + "px";

  $wrapper.css({
    top,
    left
  });

  let submit = () => {
    let params = getValues(spec.fields, domFields);
    if (params) {
      close();
      spec.callback(params);
    }
  };

  $form.on('submit', event => {
    event.preventDefault();
    submit();
  });

  $form.on('keydown', event => {
    if (event.keyCode == 27) {
      event.preventDefault();
      close();
    } else if (event.keyCode == 13 && !(event.ctrlKey || event.metaKey || event.shiftKey)) {
      event.preventDefault();
      submit();
    }
  });

  // Prevent tabbing outside dialog (only adds listeners to inputs inside the
  // wrapper). Focuses on first input.
  $wrapper.lockTab();
}

function getValues(fields, domFields) {
  let i = 0,
    result = Object.create(null);

  for (let name in fields) {
    let dom = domFields[i++],
      field = fields[name];
    let value = field.read(dom);
    let bad = field.validate(value);
    if (bad) {
      reportInvalid(dom, bad);
      return null;
    }
    result[name] = field.clean(value);
  }
  return result;
}

function reportInvalid(dom, message) {
  // FIXME this is awful and needs a lot more work
  let parent = dom.parentNode;
  let msg = parent.appendChild(document.createElement("div"));
  msg.style.left = (dom.offsetLeft + dom.offsetWidth + 2) + "px";
  msg.style.top = (dom.offsetTop - 5) + "px";
  msg.className = "ProseMirror-invalid";
  msg.textContent = message;
  setTimeout(() => parent.removeChild(msg), 1500);
}

// ::- The type of field that `FieldPrompt` expects to be passed to it.
export class Field {
  // :: (Object)
  // Create a field with the given options. Options support by all
  // field types are:
  //
  // **`value`**`: ?any`
  //   : The starting value for the field.
  //
  // **`label`**`: string`
  //   : The label for the field.
  //
  // **`required`**`: ?bool`
  //   : Whether the field is required.
  //
  // **`validate`**`: ?(any) → ?string`
  //   : A function to validate the given value. Should return an
  //     error message if it is not valid.
  constructor(options) {
    this.options = options;
  }

  // render:: (state: EditorState, props: Object) → dom.Node
  // Render the field to the DOM. Should be implemented by all subclasses.

  // :: (dom.Node) → any
  // Read the field's value from its DOM node.
  read(dom) {
    return dom.value;
  }

  // :: (any) → ?string
  // A field-type-specific validation function.
  validateType(_value) {
    // Implement me if you need me
  }

  validate(value) {
    if (!value && this.options.required)
      return msg('required field');
    return this.validateType(value) || (this.options.validate && this.options.validate(value));
  }

  clean(value) {
    return this.options.clean ? this.options.clean(value) : value;
  }
}

// ::- A field class for single-line text fields.
export class TextField extends Field {
  render() {
    let input = document.createElement("input");
    input.type = "text";
    input.placeholder = this.options.label;
    input.value = this.options.value || "";
    input.autocomplete = "off";
    return input;
  }
}


// ::- A field class for dropdown fields based on a plain `<select>`
// tag. Expects an option `options`, which should be an array of
// `{value: string, label: string}` objects, or a function taking a
// `ProseMirror` instance and returning such an array.
export class SelectField extends Field {
  render() {
    let select = document.createElement("select");
    this.options.options.forEach(o => {
      let opt = select.appendChild(document.createElement("option"));
      opt.value = o.value;
      opt.selected = o.value == this.options.value;
      opt.label = o.label;
    });
    return select;
  }
}
