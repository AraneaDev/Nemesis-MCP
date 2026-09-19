export class Cart {
  remove(sku: string): boolean {
    return sku.length > 0;
  }
}
