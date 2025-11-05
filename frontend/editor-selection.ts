interface TextRange {
  text: string;
  moveToElementText(element: HTMLElement): void;
  setEndPoint(how: string, sourceRange: TextRange): void;
  moveStart(unit: string, count: number): void;
  moveEnd(unit: string, count: number): void;
  collapse(toStart: boolean): void;
  select(): void;
}

export interface SavedSelectionRange {
  start: number;
  end: number;
}

type SaveSelectionFn = (containerEl: HTMLElement) => SavedSelectionRange;
type RestoreSelectionFn = (containerEl: HTMLElement, savedSel: SavedSelectionRange) => void;

let saveSelection: SaveSelectionFn;
let restoreSelection: RestoreSelectionFn;

// Original code by Tim Down; CC-BY-SA - http://ur1.ca/qryjg
if (typeof window !== 'undefined' && window.getSelection && document.createRange) {
  saveSelection = (containerEl: HTMLElement): SavedSelectionRange => {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return { start: 0, end: 0 };

    const range = selection.getRangeAt(0).cloneRange();
    const preSelectionRange = range.cloneRange();
    preSelectionRange.selectNodeContents(containerEl);
    preSelectionRange.setEnd(range.startContainer, range.startOffset);
    const start = preSelectionRange.toString().length;

    return {
      start,
      end: start + range.toString().length,
    };
  };

  restoreSelection = (containerEl: HTMLElement, savedSel: SavedSelectionRange): void => {
    let charIndex = 0;
    const range = document.createRange();
    range.setStart(containerEl, 0);
    range.collapse(true);
    const nodeStack: Node[] = [containerEl];
    let node: Node | undefined;
    let foundStart = false;
    let stop = false;

    while (!stop && (node = nodeStack.pop())) {
      if (node.nodeType === Node.TEXT_NODE && node.textContent !== null) {
        const textLength = node.textContent.length;
        const nextCharIndex = charIndex + textLength;

        if (!foundStart && savedSel.start >= charIndex && savedSel.start <= nextCharIndex) {
          range.setStart(node, savedSel.start - charIndex);
          foundStart = true;
        }

        if (foundStart && savedSel.end >= charIndex && savedSel.end <= nextCharIndex) {
          range.setEnd(node, savedSel.end - charIndex);
          stop = true;
        }

        charIndex = nextCharIndex;
      } else if (node.hasChildNodes()) {
        let i = node.childNodes.length;
        while (i--) nodeStack.push(node.childNodes[i]);
      }
    }

    const selection = window.getSelection();
    if (!selection) return;

    selection.removeAllRanges();
    selection.addRange(range);
  };
} else {
  const legacyDocument = document as Document & {
    selection?: {
      createRange: () => TextRange;
    };
    body: HTMLElement & {
      createTextRange: () => TextRange;
    };
  };

  if (legacyDocument.selection) {
    saveSelection = (containerEl: HTMLElement): SavedSelectionRange => {
      const selectedTextRange = legacyDocument.selection!.createRange();
      const preSelectionTextRange = legacyDocument.body.createTextRange();
      preSelectionTextRange.moveToElementText(containerEl);
      preSelectionTextRange.setEndPoint('EndToStart', selectedTextRange);
      const start = preSelectionTextRange.text.length;

      return {
        start,
        end: start + selectedTextRange.text.length,
      };
    };

    restoreSelection = (containerEl: HTMLElement, savedSel: SavedSelectionRange): void => {
      const textRange = legacyDocument.body.createTextRange();
      textRange.moveToElementText(containerEl);
      textRange.collapse(true);
      textRange.moveEnd('character', savedSel.end);
      textRange.moveStart('character', savedSel.start);
      textRange.select();
    };
  }
}

if (!saveSelection || !restoreSelection) {
  saveSelection = () => ({ start: 0, end: 0 });
  restoreSelection = () => {};
}

export { saveSelection, restoreSelection };
