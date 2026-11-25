export interface FlagBinding {
  readonly key: string
  readonly defaultValue: boolean
}

export interface DeclarationAvailability {
  readonly id: string
  readonly kind: 'feature' | 'group'
  readonly bindings: readonly FlagBinding[]
}

export async function evaluateAvailability(
  bindings: readonly FlagBinding[],
  evaluate: (binding: FlagBinding) => boolean | Promise<boolean>,
): Promise<boolean> {
  for (const binding of bindings) {
    if (!(await evaluate(binding))) return false
  }
  return true
}
