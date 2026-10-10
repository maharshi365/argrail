// Compile-only assertions. Generic function comparison rejects any, widened unions, and changed modifiers.
type Equal<Actual, Expected> =
  (<T>() => T extends Actual ? 1 : 2) extends
  (<T>() => T extends Expected ? 1 : 2) ? true : false

export declare function expectTypeOf<Actual>(value: Actual): {
  toEqualTypeOf<Expected>(...mismatch: Equal<Actual, Expected> extends true ? [] : [never]): void
}
