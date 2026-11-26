// Current recorder names are separate from historical GPS observations.
const compiled = new WeakMap();
export function currentRadioName(snapshot, system, unit) {
  const rows = snapshot?.rows?.[system] || [];
  let patterns = compiled.get(rows);
  if (!patterns) {
    patterns = rows.flatMap(({ unit: pattern, name }) => {
      try {
        const re = pattern.startsWith('/') && pattern.endsWith('/') ? new RegExp(pattern.slice(1, -1)) :
          new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
        return [[re, name.replace(/\\(\d+)/g, '$$$1')]];
      } catch { return []; }
    });
    compiled.set(rows, patterns);
  }
  const id = String(unit), hit = patterns.find(([re]) => re.test(id));
  const user = hit ? id.replace(hit[0], hit[1]).trim() : '';
  const heard = snapshot?.aliases?.[system]?.[id]?.trim() || '';
  const mode = snapshot?.modes?.[system] || 'user';
  return mode === 'none' ? '' : mode === 'user_only' ? user : mode === 'ota' ? heard || user : user || heard;
}
export function hasCurrentRadioName(snapshot, system, unit) {
  return !!snapshot?.completeAliases?.[system] || ['none', 'user_only'].includes(snapshot?.modes?.[system]) ||
    Object.hasOwn(snapshot?.rows || {}, system) || Object.hasOwn(snapshot?.aliases?.[system] || {}, String(unit));
}
