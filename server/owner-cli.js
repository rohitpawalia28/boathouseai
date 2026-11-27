// Helpers for the owner scripts: ask a question, or ask for a password without showing it on the screen.
// One reader is used for all questions so typed or piped input is never lost between them.
import readline from 'node:readline';

export function prompter() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });
  const lines = rl[Symbol.asyncIterator]();
  let muted = false;
  rl._writeToOutput = (s) => { if (!muted) process.stdout.write(s); };
  const next = async () => String((await lines.next()).value ?? '');
  return {
    async ask(q) { process.stdout.write(q); return (await next()).trim(); },
    async askHidden(q) { process.stdout.write(q); muted = true; const a = await next(); muted = false; process.stdout.write('\n'); return a; },
    close() { rl.close(); },
  };
}
