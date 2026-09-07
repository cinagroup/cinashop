export interface FormUploadTicket { index: number; generation: number; sequence: number }

/** Per-component upload ownership; stale completions cannot mutate a new form or clear its busy state. */
export class SystemFormUploads {
  private generation = 0;
  private sequence = 0;
  private readonly active = new Map<number, FormUploadTicket>();
  constructor(private readonly publish: (indices: number[]) => void) {}
  begin(index: number): FormUploadTicket | null {
    if (this.active.has(index)) return null;
    const ticket = { index, generation: this.generation, sequence: ++this.sequence };
    this.active.set(index, ticket);
    this.publish([...this.active.keys()]);
    return ticket;
  }
  current(ticket: FormUploadTicket): boolean {
    return ticket.generation === this.generation && this.active.get(ticket.index) === ticket;
  }
  finish(ticket: FormUploadTicket): void {
    if (!this.current(ticket)) return;
    this.active.delete(ticket.index);
    this.publish([...this.active.keys()]);
  }
  reset(): void {
    this.generation++;
    this.active.clear();
    this.publish([]);
  }
}
