export async function readConcurrently<Item, T>(
  items: readonly Item[],
  limit: number,
  read: (item: Item) => Promise<T>,
): Promise<T[]> {
  const results: T[] = [];
  let next = 0;
  async function readNext(): Promise<void> {
    const index = next++;
    if (index >= items.length) return;
    results[index] = await read(items[index]!);
    return readNext();
  }
  await Promise.all(Array.from({ length: Math.min(items.length, limit) }, readNext));
  return results;
}
