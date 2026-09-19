export interface CatalogItem {
  sku: string;
  title: string;
}

export class CatalogService {
  findBySku(sku: string): CatalogItem {
    return { sku, title: 'Example' };
  }

  removeBySku(sku: string): boolean {
    return sku.length > 0;
  }
}
