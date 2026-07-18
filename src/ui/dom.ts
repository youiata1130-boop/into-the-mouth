export function getAppRoot(): HTMLDivElement {
  const element = document.querySelector<HTMLDivElement>("#app");

  if (!element) throw new Error("App root was not found.");
  return element;
}

export function getFocusedControlIdentity(): string | null {
  const element = document.activeElement;

  if (element instanceof HTMLButtonElement && element.dataset.action) {
    return ["button", element.dataset.action, element.dataset.playerId ?? "", element.dataset.slotIndex ?? ""].join(":");
  }

  if (element instanceof HTMLSelectElement) return `select:${element.name}`;
  return null;
}

export function restoreFocusedControl(root: HTMLElement, identity: string | null): void {
  if (!identity) return;

  const controls = root.querySelectorAll<HTMLButtonElement | HTMLSelectElement>("button[data-action], select[name]");

  for (const control of controls) {
    const controlIdentity = control instanceof HTMLButtonElement
      ? ["button", control.dataset.action, control.dataset.playerId ?? "", control.dataset.slotIndex ?? ""].join(":")
      : `select:${control.name}`;

    if (controlIdentity !== identity || control.disabled) continue;
    control.focus({ preventScroll: true });
    return;
  }
}
