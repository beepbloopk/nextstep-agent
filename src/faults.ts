// Fault injection so failure paths are exercised by real code, not described in comments.
// Each fault fires once and is then consumed, so a retry can succeed.

export type SendFault = "fail_before_delivery" | "fail_after_delivery";

export class Faults {
  private sendQueue: SendFault[] = [];
  private taskFailures = new Set<number>();

  /** Next sendMessage call fails in this way. */
  failNextSend(mode: SendFault): this {
    this.sendQueue.push(mode);
    return this;
  }

  /** The createTask batch fails at this index (0-based), once. */
  failTaskAt(index: number): this {
    this.taskFailures.add(index);
    return this;
  }

  takeSendFault(): SendFault | null {
    return this.sendQueue.shift() ?? null;
  }

  takeTaskFailure(index: number): boolean {
    if (!this.taskFailures.has(index)) return false;
    this.taskFailures.delete(index);
    return true;
  }
}
