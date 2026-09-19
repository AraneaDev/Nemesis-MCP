import { describe, expect, it } from 'vitest';
import { emptyGraph, resolveType, resolveMember, suggestMember, similarity } from '../../src/core/symbolGraph.js';
import type { TypeSymbol } from '../../src/core/types.js';

function makeType(name: string, methods: string[] = []): TypeSymbol {
  return {
    name,
    file: 'src/x.ts',
    kind: 'class',
    methods: new Map(
      methods.map((m) => [
        m,
        { name: m, returnType: null, params: [], visibility: 'public', line: 1 },
      ]),
    ),
    unknownMembers: new Set(),
    extends: [],
    implements: [],
    uses: [],
    line: 1,
  };
}

describe('symbolGraph', () => {
  it('adds and resolves types case-insensitively', () => {
    const g = emptyGraph();
    const t = makeType('App\\Services\\InvoiceService');
    g.types.set('app\\services\\invoiceservice', t);
    expect(resolveType(g, 'App\\Services\\InvoiceService')).toBe(t);
    expect(resolveType(g, 'app\\services\\invoiceservice')).toBe(t);
  });

  it('resolves short names uniquely', () => {
    const g = emptyGraph();
    const t = makeType('App\\PaymentGateway');
    g.types.set('app\\paymentgateway', t);
    expect(resolveType(g, 'PaymentGateway')).toBe(t);
  });

  it('walks implements chains when resolving members', () => {
    const g = emptyGraph();
    const iface = makeType('App\\Contracts\\PaymentGateway', ['chargeToken']);
    const impl = makeType('App\\StripeGateway', []);
    impl.implements.push('App\\Contracts\\PaymentGateway');
    g.types.set('app\\contracts\\paymentgateway', iface);
    g.types.set('app\\stripegateway', impl);
    const hit = resolveMember(g, impl, 'chargeToken');
    expect(hit).not.toBeNull();
    expect(hit!.owner.name).toBe('App\\Contracts\\PaymentGateway');
    expect(hit!.qualifiedName).toBe('App\\Contracts\\PaymentGateway::chargeToken');
  });

  it('suggests similar member names', () => {
    const t = makeType('X', ['chargeToken', 'refund']);
    expect(suggestMember(t, 'chargeWithToken')).toBe('chargeToken');
    expect(suggestMember(t, 'refnd')).toBe('refund');
  });

  it('does not suggest for wildly different names', () => {
    const t = makeType('X', ['chargeToken']);
    expect(suggestMember(t, 'zzzzzzzz')).toBeNull();
  });

  it('similarity distance sanity', () => {
    expect(similarity('abc', 'abc')).toBe(0);
    expect(similarity('abc', 'abd')).toBe(1);
    expect(similarity('', 'abc')).toBe(3);
  });
});
