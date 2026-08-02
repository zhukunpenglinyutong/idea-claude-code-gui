export async function waitUntil(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 2_000,
  intervalMs = 10,
): Promise<void> {
  const start = Date.now();
  while (!(await condition())) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitUntil timed out');
    }
    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
  }
}
