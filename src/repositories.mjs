// Per-repository review settings live in this trusted checkout, never in the
// reviewed repository: prepareCommand runs on the review host.
export function repositorySettings(config, repo) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('repositories.json must be an object keyed by owner/repo');
  const name = Object.keys(config).find(key => key.toLowerCase() === repo.toLowerCase());
  const { prepareCommand = '', sourceSubmodules = [], ...unknown } = name ? config[name] : {};
  if (typeof prepareCommand !== 'string' || /[\r\n]/.test(prepareCommand)) throw new Error(`repositories.json ${name}: prepareCommand must be a single-line string`);
  if (!Array.isArray(sourceSubmodules) || sourceSubmodules.some(path => typeof path !== 'string')) throw new Error(`repositories.json ${name}: sourceSubmodules must be an array of strings`);
  if (Object.keys(unknown).length) throw new Error(`repositories.json ${name}: unknown settings ${Object.keys(unknown).join(', ')}`);
  return { prepareCommand, sourceSubmodules };
}
