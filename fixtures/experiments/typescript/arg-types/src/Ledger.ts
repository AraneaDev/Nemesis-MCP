export class Ledger {
  post(amount: number, currency: string): boolean {
    return amount > 0 && currency.length === 3;
  }
}
