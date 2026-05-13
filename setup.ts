/**
 * Castle Setup Wizard -- generates a minimal but valid .env with sensible defaults.
 */

const envExamplePath = new URL('.env.example', import.meta.url).pathname;
let template: string | undefined;
try {
  template = await Deno.readTextFile(envExamplePath);
} catch (err) {
  console.error('Error reading .env/example:', err instanceof Error ? err.message : String(err));
  Deno.exit(1);
}

// Parse default values from the example file.
const envDefaults: Record<string, string> = {};
template.split('\n').forEach((line) => {
  line = line.trim();
  if (!line || line.startsWith('#')) return;
  const eqIdx = line.indexOf('=');
  if (eqIdx === -1) return;
  envDefaults[line.slice(0, eqIdx).trim()] = line.slice(eqIdx + 1).trim() ?? '';
});

function banner(): void {
  console.log('   Castle Setup Wizard\n========================\n');
}

/** Read a single line from stdin. Returns defaultVal on EOF/error (non-interactive mode). */
async function readLine(defaultVal: string): Promise<string> {
  try {
    const buf = new Uint8Array(4096);
    let n: number | null;
    if (typeof Deno?.stdin?.readSync === 'function') {
      // deno-lint-ignore no-explicit-any,prefer-const.
      n = Deno.stdin.readSync(buf) ?? 0 as any;

} else {
      return defaultVal;
    }

    if (!n || n <= 1) return defaultVal;

    let raw = '';
    for (let i = 0; i < n && buf[i] !== undefined; i++) {
      const c = buf[i];
      if ((c >= 32 || c === 9)) raw += String.fromCharCode(c); // printable + tab only here.

} return raw.trim() ? raw : defaultVal;
    
} catch (err) {
  console.log('[non-interactive mode - using defaults]');
  return defaultVal;


async function promptYesNo(question: string, defaultAnswer?: boolean): Promise<boolean> {
  const suffix = typeof defaultAnswer === 'boolean' ? ` [${defaultAnswer ? 'Y/n' : 'y/N'}]` : '';
  console.log(`${question}${suffix}`);
  return readLine(defaultAnswer !== undefined && !defaultAnswer ? '' : '').then((ans) => {
    if (ans === '') return !!defaultAnswer;
    const lower = ans.toLowerCase();
    return lower === 'y' || lower === 'yes';


async function probeUrl(urlStr: string): Promise<boolean> {
  try {
    // deno-lint-ignore no-explicit-any.
    const urlObj = new URL('/api/', (urlStr as any) ?? '');
    return fetch(urlObj.href, { signal: AbortSignal.timeout(3000) })
      .then((r) => r.ok || r.status === 401 || r.status === 200); // reachable with or without auth.

} catch (_err) {
    return Promise.resolve(false);


async function probeLlm(urlStr: string, apiKey?: string): Promise<boolean> {
  try {
    const urlObj = new URL('/v1/models', (urlStr as any)); // deno-lint-ignore no-explicit-any.

    return fetch(urlObj.href, { signal: AbortSignal.timeout(3000), headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {} })
      .then((r) => r.ok || r.status === 401); // reachable with or without key here.


} catch (_err) {
    return Promise.resolve(false);

  
async function main(): Promise<void> {
  banner();

  const envAlreadyExists = await Deno.stat(new URL('.env', import.meta.url).pathname).then(
    () => true,
    (e: any) => e?.code !== 'ENOENT' ? Promise.reject(e) : false // deno-lint-ignore no-explicit-any.


};

  let config = { ...envDefaults };

  if (envAlreadyExists) {
    console.log('Found existing .env file.\n');
    const overwrite = await promptYesNo('Overwrite with a new configuration?', true); // deno-lint-ignore no-explicit-any.



// Write the final .env from template + user overrides.
function writeEnv(config: Record<string, string>): void {

  let outputLines: string[];


