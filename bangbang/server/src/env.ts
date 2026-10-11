// Loud config access: a missing key is an error that says exactly what to set.
export function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not configured — set it in bangbang/server/.env (see .env.example)`);
  return v;
}

export function opt(name: string, fallback?: string): string | undefined {
  return process.env[name] || fallback;
}
