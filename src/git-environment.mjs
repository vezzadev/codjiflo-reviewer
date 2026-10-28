// Repository/config selectors belong to the caller's checkout, not the disposable
// review checkout. Keep installation, TLS, and authentication transport settings.
const repositoryVariables = [
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_OBJECT_DIRECTORY', 'GIT_DIR',
  'GIT_WORK_TREE', 'GIT_IMPLICIT_WORK_TREE', 'GIT_GRAFT_FILE', 'GIT_INDEX_FILE',
  'GIT_NO_REPLACE_OBJECTS', 'GIT_REPLACE_REF_BASE', 'GIT_PREFIX',
  'GIT_SHALLOW_FILE', 'GIT_COMMON_DIR', 'GIT_NAMESPACE', 'GIT_CEILING_DIRECTORIES',
];

export function sanitizeGitEnv(inherited) {
  const env = { ...inherited };
  for (const name of repositoryVariables) delete env[name];
  for (const name of Object.keys(env)) {
    if (name.startsWith('GIT_CONFIG')) delete env[name];
  }
  return env;
}
