/* Minimal assertion harness shared by the Node test scripts. */
let pass = 0;
let fail = 0;

export function assert(label: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    pass++;
    console.log(`  ✅ ${label}`);
  } else {
    fail++;
    console.log(`  ❌ ${label}`);
    if (detail !== undefined) console.log(`     got: ${JSON.stringify(detail)}`);
  }
}

export function eq<T>(label: string, actual: T, expected: T): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  assert(label, ok, ok ? undefined : actual);
  if (!ok) console.log(`     expected: ${JSON.stringify(expected)}`);
}

export function section(name: string): void {
  console.log(`\n■ ${name}`);
}

export function done(): void {
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}
