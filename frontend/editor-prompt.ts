import type { EditorView } from 'prosemirror-view';
import $ from './lib/jquery.js';
import { msg } from './libreviews.js';

// Helper module for menu prompts. Derived from
// https://github.com/ProseMirror/prosemirror-example-setup/blob/master/src/prompt.js
const prefix = "ProseMirror-prompt";

interface FieldOptions<TValue = unknown> {
  value?: TValue;
  label?: string;
  required?: boolean;
  validate?: (value: TValue) => string | undefined;
  clean?: (value: TValue) => TValue;
}

export interface PromptSpec {
  title?: string;
  fields: Record<string, Field>;
  view: EditorView & {
    disable(): void;
    enable(): void;
  };
  callback: (attrs: Record<string, unknown>) => void;
}

type PromptFieldValue = string | number | boolean | null | undefined;

export function openPrompt(spec: PromptSpec): void {
  // We want modal-like behavior, so we disable the active view
  spec.view.disable();

  const $rteContainer = $(spec.view.dom).parent().parent();
  const $wrapper = $('<div>').addClass(prefix).prependTo($rteContainer);

  // Close prompt
  function close(): void {
    $(window).off('mousedown', maybeClose);
    $wrapper.remove();
    spec.view.enable();
    spec.view.focus();
  }

  // Close prompt on outside clicks
  function maybeClose(event: JQuery.Event): void {
    const withTarget = event as JQuery.Event & { target: EventTarget | null };
    const targetNode = withTarget.target as Node | null;
    if (!targetNode || !$wrapper[0].contains(targetNode))
      close();
  }

  setTimeout(() => $(window).on('mousedown', maybeClose), 50);

  const domFields: HTMLElement[] = [];
  for (let name in spec.fields)
    domFields.push(spec.fields[name]!.render());

  const $submitButton = $('<button>')
    .attr('type', 'submit')
    .addClass(`${prefix}-submit pure-button pure-button-primary`)
    .text(msg('ok'));

  const $cancelButton = $('<button>')
    .attr('type', 'button')
    .addClass(`${prefix}-cancel pure-button`)
    .text(msg('cancel'));

  $cancelButton.on('click', close);

  const $form = $('<form>').appendTo($wrapper);
  if (spec.title)
    $('<h5>').text(spec.title).appendTo($form);

  domFields.forEach(field => $('<div>').append($(field)).appendTo($form));

  const $buttons = $('<div>')
    .addClass(`${prefix}-buttons`)
    .appendTo($form);
  $buttons.append($submitButton, ' ', $cancelButton);

  const dialogBox = $wrapper[0].getBoundingClientRect();
  const editorBox = $rteContainer[0].getBoundingClientRect();
  const centeredX = (editorBox.width / 2) - (dialogBox.width / 2);
  const centeredY = (editorBox.height / 2) - (dialogBox.height / 2);

  $wrapper.css({
    top: `${centeredY}px`,
    left: `${centeredX}px`
  });

  const submit = (): void => {
    const params = getValues(spec.fields, domFields);
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
    if (event.which === 27) {
      event.preventDefault();
      close();
    } else if (event.which === 13 && !(event.ctrlKey || event.metaKey || event.shiftKey)) {
      event.preventDefault();
      submit();
    }
  });

  // Prevent tabbing outside dialog (only adds listeners to inputs inside the
  // wrapper). Focuses on first input.
  $wrapper.lockTab();
}

function getValues(fields: Record<string, Field>, domFields: HTMLElement[]): Record<string, unknown> | null {
  let i = 0;
  const result: Record<string, unknown> = Object.create(null);

  for (let name in fields) {
    const dom = domFields[i++];
    const field = fields[name]!;
    const value = field.read(dom);
    const bad = field.validate(value);
    if (bad) {
      reportInvalid(dom, bad);
      return null;
    }
    result[name] = field.clean(value);
  }
  return result;
}

function reportInvalid(dom: HTMLElement, message: string): void {
  const parent = dom.parentNode as HTMLElement;
  const errorMsg = parent.appendChild(document.createElement("div"));
  errorMsg.style.left = (dom.offsetLeft + dom.offsetWidth + 2) + "px";
  errorMsg.style.top = (dom.offsetTop - 5) + "px";
  errorMsg.className = "ProseMirror-invalid";
  errorMsg.textContent = message;
  setTimeout(() => parent.removeChild(errorMsg), 1500);
}

// ::- The type of field that `FieldPrompt` expects to be passed to it.
export class Field<TValue extends PromptFieldValue = string> {
  protected options: FieldOptions<TValue>;

  constructor(options: FieldOptions<TValue>) {
    this.options = options;
  }

  // Render the field to the DOM. Should be implemented by all subclasses.
  render(): HTMLElement {
    throw new Error('render() must be implemented by subclasses');
  }

  // Read the field's value from its DOM node.
  read(dom: HTMLElement): TValue {
    return (dom as HTMLInputElement).value as TValue;
  }

  // A field-type-specific validation function.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  protected validateType(_value: TValue): string | undefined {
    // Implement me if you need me
    return undefined;
  }

  validate(value: TValue): string | undefined {
    if (!value && this.options.required)
      return msg('required field');
    return this.validateType(value) || (this.options.validate && this.options.validate(value));
  }

  clean(value: TValue): TValue {
    return this.options.clean ? this.options.clean(value) : value;
  }
}

// ::- A field class for single-line text fields.
export class TextField extends Field<string> {
  override render(): HTMLInputElement {
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = this.options.label ?? '';
    input.value = this.options.value ?? "";
    input.autocomplete = "off";
    return input;
  }
}

interface SelectOption {
  value: string;
  label: string;
}

interface SelectFieldOptions extends FieldOptions<string> {
  options: SelectOption[];
}

// ::- A field class for dropdown fields based on a plain `<select>`
// tag.
export class SelectField extends Field<string> {
  private readonly selectOptions: SelectFieldOptions;

  constructor(options: SelectFieldOptions) {
    super(options);
    this.selectOptions = options;
  }

  override render(): HTMLSelectElement {
    const select = document.createElement("select");
    this.selectOptions.options.forEach(o => {
      const opt = select.appendChild(document.createElement("option"));
      opt.value = o.value;
      opt.selected = o.value === (this.options.value ?? '');
      opt.label = o.label;
    });
    return select;
  }

  override read(dom: HTMLElement): string {
    return (dom as HTMLSelectElement).value;
  }
}
