// Repository and command-level config selectors belong to the caller's checkout,
// not the disposable review checkout. Keep operator global/system config and
// installation, TLS, and authentication transport settings.
const repositoryVariables = [
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_OBJECT_DIRECTORY', 'GIT_DIR',
  'GIT_WORK_TREE', 'GIT_IMPLICIT_WORK_TREE', 'GIT_GRAFT_FILE', 'GIT_INDEX_FILE',
  'GIT_NO_REPLACE_OBJECTS', 'GIT_REPLACE_REF_BASE', 'GIT_PREFIX',
  'GIT_SHALLOW_FILE', 'GIT_COMMON_DIR', 'GIT_NAMESPACE', 'GIT_CEILING_DIRECTORIES',
];

export function sanitizeGitEnv(inherited) {
  const env = { ...inherited };
  for (const name of Object.keys(env)) {
    const normalized = name.toUpperCase();
    if (repositoryVariables.includes(normalized) || /^(?:GIT_CONFIG(?:_PARAMETERS|_COUNT)?|GIT_CONFIG_(?:KEY|VALUE)_\d+)$/.test(normalized)) delete env[name];
  }
  return env;
}
