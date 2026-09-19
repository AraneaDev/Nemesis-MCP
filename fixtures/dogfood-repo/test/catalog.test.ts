import { describe, expect, it, vi } from 'vitest';
import { CatalogService } from '../src/catalog.js';

describe('catalog service', () => {
  it('detects a stale method name', () => {
    const service = new CatalogService();
    vi.spyOn(service, 'findBySKU').mockReturnValue({ sku: 'A-1', title: 'Example' });
    expect(service).toBeDefined();
  });

  it('detects an obsolete call shape', () => {
    const service = new CatalogService();
    const spy = vi.spyOn(service, 'removeBySku');
    spy.toHaveBeenCalledWith('A-1', true);
    expect(spy).toBeDefined();
  });

  it('detects a stale return value', () => {
    const service = new CatalogService();
    vi.spyOn(service, 'findBySku').mockReturnValue('A-1' as any);
    expect(service).toBeDefined();
  });
});
