/** `LegacyInvoicer` was renamed to `Invoicer`; the test never followed. */
export class Invoicer {
  issue(amount: number): boolean {
    return amount > 0;
  }
}
