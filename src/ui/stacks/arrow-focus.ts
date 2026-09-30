/**
 * Arrow-key movement between the focusable items of a list (↑/↓, Home/End), skipping hidden ones. Returns false when
 * the key isn't handled or focus would leave the top of the list, so the caller can move focus elsewhere.
 */
export function moveFocus(container: HTMLElement, selector: string, key: string): boolean {
  const items = [...container.querySelectorAll<HTMLElement>(selector)].filter(
    (el) => el.getClientRects().length > 0,
  );
  if (items.length === 0) return false;
  const current = items.indexOf(document.activeElement as HTMLElement);
  let next: number;
  switch (key) {
    case 'ArrowDown':
      next = current === -1 ? 0 : Math.min(current + 1, items.length - 1);
      break;
    case 'ArrowUp':
      if (current <= 0) return false;
      next = current - 1;
      break;
    case 'Home':
      next = 0;
      break;
    case 'End':
      next = items.length - 1;
      break;
    default:
      return false;
  }
  items[next]!.focus();
  return true;
}
