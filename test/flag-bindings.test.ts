import { describe, expect, it } from 'vitest'
import { compileFlagBindings, readFlagBindings } from '../src/integrations/flag-bindings.js'
import { evaluateAvailability } from '../src/runtime/server/policy.js'
import type { FeatureRegistry } from '../src/core/types.js'

const registry: FeatureRegistry = {
  features: [
    { id: 'shop', name: 'shop', kind: 'feature', origin: 'feature-root', sources: [], children: ['shop/checkout'] },
    { id: 'shop/checkout', name: 'checkout', parentId: 'shop', kind: 'group', origin: 'feature-root', sources: [], children: ['shop/checkout/payment'] },
    { id: 'shop/checkout/payment', name: 'payment', parentId: 'shop/checkout', kind: 'feature', origin: 'feature-root', sources: [], children: [] },
    { id: 'support', name: 'support', kind: 'feature', origin: 'feature-root', sources: [], children: [] },
  ],
}

describe('flag bindings', () => {
  it('requires every bound ancestor and the declaration while leaving unbound declarations available', async () => {
    const configured = {
      shop: { key: 'feature.shop' },
      'shop/checkout': { key: 'feature.checkout', defaultValue: true },
      'shop/checkout/payment': { key: 'feature.payment' },
    }
    const table = compileFlagBindings(registry, readFlagBindings(configured))
    configured.shop.key = 'changed'
    const payment = table.find(({ id }) => id === 'shop/checkout/payment')!
    expect(payment.bindings.map(({ key }) => key)).toEqual([
      'feature.shop', 'feature.checkout', 'feature.payment',
    ])
    expect(Object.isFrozen(payment.bindings[0])).toBe(true)
    expect(Object.isFrozen(payment.bindings)).toBe(true)
    expect(Object.isFrozen(table)).toBe(true)
    for (const disabled of payment.bindings) {
      await expect(evaluateAvailability(payment.bindings, (flag) => flag !== disabled)).resolves.toBe(false)
    }
    await expect(evaluateAvailability(payment.bindings, () => true)).resolves.toBe(true)
    await expect(evaluateAvailability(payment.bindings, ({ defaultValue }) => defaultValue)).resolves.toBe(false)
    const support = table.find(({ id }) => id === 'support')!
    await expect(evaluateAvailability(support.bindings, () => false)).resolves.toBe(true)
  })

  it.each([
    [{ shop: { key: '' } }, /key/],
    [{ shop: { key: ' trailing ' } }, /key/],
    [{ shop: { key: 'flag\nkey' } }, /key/],
    [{ shop: { key: 'flag', defaultValue: 'true' } }, /defaultValue/],
    [{ shop: { key: 'flag', expose: true } }, /unknown field/],
    [{ 'shop/unknown': { key: 'flag' } }, /unknown declaration/],
    [{ '@pages/(dashboard)': { key: 'flag' } }, /unknown native Group/],
  ])('rejects invalid binding configuration %j', (config, error) => {
    expect(() => compileFlagBindings(registry, readFlagBindings(config))).toThrow(error)
  })
})
