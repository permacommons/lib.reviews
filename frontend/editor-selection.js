let saveSelection;
let restoreSelection;

// Original code by Tim Down; CC-BY-SA - http://ur1.ca/qryjg
if (window.getSelection && document.createRange) {
  saveSelection = function(containerEl) {
    const range = window.getSelection().getRangeAt(0);
    const preSelectionRange = range.cloneRange();
    preSelectionRange.selectNodeContents(containerEl);
    preSelectionRange.setEnd(range.startContainer, range.startOffset);
    const start = preSelectionRange.toString().length;

    return {
      start,
      end: start + range.toString().length
    };
  };

  restoreSelection = function(containerEl, savedSel) {
    let charIndex = 0;
    const range = document.createRange();
    range.setStart(containerEl, 0);
    range.collapse(true);
    let node,
      nodeStack = [containerEl],
      foundStart = false,
      stop = false;

    while (!stop && (node = nodeStack.pop())) {
      if (node.nodeType == 3) {
        let nextCharIndex = charIndex + node.length;
        if (!foundStart && savedSel.start >= charIndex && savedSel.start <= nextCharIndex) {
          range.setStart(node, savedSel.start - charIndex);
          foundStart = true;
        }
        if (foundStart && savedSel.end >= charIndex && savedSel.end <= nextCharIndex) {
          range.setEnd(node, savedSel.end - charIndex);
          stop = true;
        }
        charIndex = nextCharIndex;
      } else {
        let i = node.childNodes.length;
        while (i--) {
          nodeStack.push(node.childNodes[i]);
        }
      }
    }

    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  };
} else if (document.selection) {
  saveSelection = function(containerEl) {
    const selectedTextRange = document.selection.createRange();
    const preSelectionTextRange = document.body.createTextRange();
    preSelectionTextRange.moveToElementText(containerEl);
    preSelectionTextRange.setEndPoint("EndToStart", selectedTextRange);
    const start = preSelectionTextRange.text.length;

    return {
      start,
      end: start + selectedTextRange.text.length
    };
  };

  restoreSelection = function(containerEl, savedSel) {
    const textRange = document.body.createTextRange();
    textRange.moveToElementText(containerEl);
    textRange.collapse(true);
    textRange.moveEnd("character", savedSel.end);
    textRange.moveStart("character", savedSel.start);
    textRange.select();
  };
}

if (!saveSelection || !restoreSelection) {
  saveSelection = () => ({ start: 0, end: 0 });
  restoreSelection = () => {};
}

export { saveSelection, restoreSelection };
