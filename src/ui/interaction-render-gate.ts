export class InteractionRenderGate {
  private readonly pointerIds = new Set<number>();
  private readonly keyboardCodes = new Set<string>();
  private pendingRender = false;

  beginPointer(pointerId: number): void {
    this.pointerIds.add(pointerId);
  }

  hasPointer(pointerId: number): boolean {
    return this.pointerIds.has(pointerId);
  }

  endPointer(pointerId: number): boolean {
    return this.pointerIds.delete(pointerId);
  }

  beginKeyboard(code: string): void {
    this.keyboardCodes.add(code);
  }

  hasKeyboard(code: string): boolean {
    return this.keyboardCodes.has(code);
  }

  endKeyboard(code: string): boolean {
    return this.keyboardCodes.delete(code);
  }

  clearInteractions(): void {
    this.pointerIds.clear();
    this.keyboardCodes.clear();
  }

  deferRenderIfInteracting(): boolean {
    if (!this.isInteracting()) return false;
    this.pendingRender = true;
    return true;
  }

  consumePendingRender(): boolean {
    if (this.isInteracting() || !this.pendingRender) return false;
    this.pendingRender = false;
    return true;
  }

  markRendered(): void {
    this.pendingRender = false;
  }

  private isInteracting(): boolean {
    return this.pointerIds.size > 0 || this.keyboardCodes.size > 0;
  }
}
