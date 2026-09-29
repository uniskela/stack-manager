export async function register() {
  // The worker, SQLite and git all need the Node.js runtime; never run them in the edge runtime.
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { boot } = await import('./server/boot');
    await boot();
  }
}
