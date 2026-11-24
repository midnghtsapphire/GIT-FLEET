// Local-first, free-only attempt policy. Opt in on the computer hosting LM Studio.
export function localFirstAttempts(env = process.env) {
  if (env.FLEET_LOCAL_FIRST !== '1') return null;
  const model = (env.LMSTUDIO_MODEL || '').trim();
  if (!model) throw new Error('FLEET_LOCAL_FIRST=1 requires LMSTUDIO_MODEL to name a loaded chat model');
  const attempts = [{ provider: 'lmstudio', model }];
  if (env.FLEET_FREE_FALLBACK === '1') {
    attempts.push({ provider: 'openrouter', model: 'openrouter/free' });
  }
  return attempts;
}
