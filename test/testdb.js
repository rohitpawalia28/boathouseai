// Where the tests keep their data. By default a small in-memory stand-in (no database needed).
// To run the very same tests on a real MongoDB (Atlas), put TEST_MONGODB_URI=mongodb+srv://... in .env and run: npm run test:atlas
// Every test file then gets its own fresh database "bh_test_..." whose collections are dropped at the end.
import { loadEnv } from '../server/env.js';

loadEnv();
export const TEST_URI = process.env.TEST_MONGODB_URI || 'memory://';
export const realDb = !TEST_URI.startsWith('memory:');
const fresh = () => `bh_test_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
export const dbOpts = () => ({ mongoUri: TEST_URI, mongoDb: fresh() });
export const storeOpts = () => ({ dbName: fresh() });

export async function cleanup(store) {
  if (!store) return;
  if (realDb) for (const c of await store.db.listCollections().toArray()) await store.db.collection(c.name).drop().catch(() => {});
  await store.close();
}
