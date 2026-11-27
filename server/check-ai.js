// Checks that your Gemini key works with this app's tools.  Usage: npm run check-ai
import { loadEnv, getConfig } from './env.js';
import { geminiProvider } from './ai.js';
import { toolDeclarations } from './tools.js';

loadEnv();
const cfg = getConfig();
if (!cfg.geminiKey) {
  console.log('NOT CONNECTED: GEMINI_API_KEY is empty. Open the .env file in this folder and paste your key after GEMINI_API_KEY=');
  process.exit(1);
}
const provider = geminiProvider({ apiKey: cfg.geminiKey, model: cfg.geminiModel });
try {
  const out = await provider.generate({
    system: 'You are a houseboat booking assistant. Use tools to answer.',
    contents: [{ role: 'user', parts: [{ text: 'Give me today\'s summary' }] }],
    tools: toolDeclarations(),
  });
  if (out.functionCalls.length) console.log(`CONNECTED: Gemini (${cfg.geminiModel}) understood the tools and chose "${out.functionCalls[0].name}".`);
  else console.log(`CONNECTED: Gemini (${cfg.geminiModel}) answered: ${out.text.slice(0, 100)}`);
} catch (e) {
  console.log(`NOT WORKING: Gemini said HTTP ${e.status || '?'} - ${e.detail || e.message}`);
  if (e.status === 429) console.log('That is the free quota limit. Wait a little and try again.');
  if (e.status === 400 || e.status === 403) console.log('Check the API key and the model name (GEMINI_MODEL) in .env.');
  process.exit(1);
}
