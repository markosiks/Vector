/**
 * Recursively freeze an object graph so that any mutation attempt throws in
 * strict mode (all ES modules run in strict mode). Used to make the seeded
 * config immutable at runtime, not just at the type level.
 *
 * The return type preserves the input shape while marking every property — and
 * nested array element — as `readonly`.
 */
export type DeepReadonly<T> = T extends (infer U)[]
  ? readonly DeepReadonly<U>[]
  : T extends ReadonlyArray<infer U>
    ? readonly DeepReadonly<U>[]
    : T extends object
      ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : T;

/** Freeze `value` and every nested object/array it transitively owns. */
export function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}
