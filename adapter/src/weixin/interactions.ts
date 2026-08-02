export type InteractionKind = 'permission' | 'question' | 'plan';

export interface PendingInteraction {
  readonly interactionId: string;
  readonly taskId: string;
  readonly kind: InteractionKind;
  readonly toolName?: string;
  readonly questions?: Record<string, unknown>;
  readonly askedAt: number;
}

const MAX_PENDING = 64;

/**
 * Bounded registry of pending interactions surfaced by SSE.
 *
 * The gateway itself owns first-wins semantics; this registry only maps
 * WeChat replies to the exact interactionId of the current task.
 */
export class InteractionRegistry {
  readonly #pending = new Map<string, PendingInteraction>();

  get size(): number {
    return this.#pending.size;
  }

  register(interaction: PendingInteraction): void {
    this.#pending.set(interaction.interactionId, interaction);
    while (this.#pending.size > MAX_PENDING) {
      const oldest = [...this.#pending.values()].sort((a, b) => a.askedAt - b.askedAt)[0];
      if (oldest === undefined) {
        break;
      }
      this.#pending.delete(oldest.interactionId);
    }
  }

  take(interactionId: string): PendingInteraction | undefined {
    const interaction = this.#pending.get(interactionId);
    if (interaction !== undefined) {
      this.#pending.delete(interactionId);
    }
    return interaction;
  }

  findKind(kind: InteractionKind): PendingInteraction | undefined {
    for (const interaction of this.#pending.values()) {
      if (interaction.kind === kind) {
        return interaction;
      }
    }
    return undefined;
  }

  clearForTask(taskId: string): void {
    for (const [interactionId, interaction] of this.#pending) {
      if (interaction.taskId === taskId) {
        this.#pending.delete(interactionId);
      }
    }
  }

  /** Drop all pending interactions; returns how many were invalidated. */
  clearAll(): number {
    const count = this.#pending.size;
    this.#pending.clear();
    return count;
  }
}
