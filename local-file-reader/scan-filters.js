import path from 'node:path';

export const defaultExcludedDirs = ['node_modules', '.git', '.hg', '.svn', '__pycache__', '.venv', 'venv', 'vendor', 'dist', 'build', 'target', '.next', '.cache'];
const normalized = value => value.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '').toLowerCase();
function glob(pattern) {
  const value = normalized(pattern);
  if (!value || value.length > 256 || value.split('/').includes('..') || path.isAbsolute(pattern)) throw new Error('Ignore patterns must be bounded relative paths or names.');
  let expression='';
  for(let i=0;i<value.length;i++) {
    if(value[i]==='*'&&value[i+1]==='*') {i++;if(value[i+1]==='/'){expression+='(?:[^/]+/)*';i++;}else expression+='.*';}
    else if(value[i]==='*')expression+='[^/]*';
    else expression+=value[i].replace(/[.+?^${}()|[\]\\]/g,'\\$&');
  }
  return new RegExp(`^${expression}$`, 'i');
}
export function scanFilters({use_default_excludes = true, exclude_dirs = [], exclude_patterns = [], include_extensions = [], extensions = []}) {
  const directories = [...new Set([...(use_default_excludes ? defaultExcludedDirs : []), ...exclude_dirs].map(normalized))].sort();
  const patterns = exclude_patterns.map(glob);
  const wanted = [...new Set((include_extensions.length ? include_extensions : extensions).map(value => (value.startsWith('.') ? value : '.'+value).toLowerCase()))].sort();
  return {
    identity: JSON.stringify([directories, exclude_patterns, wanted]),
    scope: {use_default_excludes, exclude_dirs:directories, exclude_patterns, include_extensions:wanted},
    excluded(root, file, directory) {
      const relative = normalized(path.relative(root, file)), name = path.basename(file).toLowerCase();
      return directory && directories.some(item => item.includes('/') ? relative === item : name === item)
        || patterns.some(pattern => pattern.test(relative) || pattern.test(name));
    },
    includes(file) { return !wanted.length || wanted.includes(path.extname(file).toLowerCase()); },
  };
}
