/** The elements that take typed text. */
const TEXT = new Set(["INPUT", "SELECT", "TEXTAREA"]);

/**
 * True while a text field the player can see has the keyboard. A field that was focused and then
 * hidden (the name box of the character screen after joining) keeps `document.activeElement` in
 * some browsers; it must not swallow W, A, S and D, and on a Mac it makes the OS offer accents
 * for a held letter.
 */
export function typingIn(
  element: { tagName: string; getClientRects(): { length: number } } | null,
) {
  return !!element && TEXT.has(element.tagName) && element.getClientRects().length > 0;
}

/** Game keys the page must claim, so the OS never treats a held letter as text. */
export const claimsKey = (event: {
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
}) =>
  !event.metaKey &&
  !event.ctrlKey &&
  !event.altKey &&
  (/^(Key[A-Z]|Digit[1-4])$/.test(event.code) ||
    ["Space", "F1", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(
      event.code,
    ));
