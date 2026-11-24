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

// A model response may already have produced files or posts; never replay then.
export function shouldRetryAfterFailure(outputReceived) {
  return outputReceived === false;
}

// Web search is the fleet's only tool and it comes from OpenRouter's attached
// plugin (see templates/fleet-contract.md). Local-first routes cannot carry it:
// LM Studio ignores OpenRouter-specific options and the free router must stay
// free. Refuse such research runs instead of silently removing the tool.
export function webPluginConflict(cfg) {
  const plugins = cfg?.extra_body?.plugins;
  if (Array.isArray(plugins) && plugins.some((p) => p?.id === 'web')) {
    return 'member requires the web search plugin (extra_body.plugins), which local-first mode cannot provide; disable FLEET_LOCAL_FIRST or drop the web plugin from this member';
  }
  return null;
}
