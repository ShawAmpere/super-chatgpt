export function normalizeDesktopContent(value) {
  value.content=(value.content||[]).flatMap(item=>{
    if(item.type!=='text')return [item];
    try {
      const parsed=JSON.parse(item.text);
      if(Array.isArray(parsed)&&parsed.every(text=>typeof text==='string'))return parsed.map(text=>({...item,text}));
    }catch{/* Preserve ordinary text exactly. */}
    return [item];
  });
  return value;
}
export function captureFailed(value) {
  const failed=text=>typeof text==='string'&&/^Error capturing (desktop state|screenshot):/i.test(text);
  return value.content?.some(item=>{
    if(item.type!=='text')return false;
    if(failed(item.text))return true;
    try { const parsed=JSON.parse(item.text);return Array.isArray(parsed)&&parsed.some(failed); }
    catch { return false; }
  })||false;
}
export function snapshotIdentity(value, prefix = 'Desktop window identity: ') {
  for (const item of value.content || []) {
    if (item.type === 'text' && item.text.startsWith(prefix)) {
      try { return JSON.parse(item.text.slice(prefix.length)); } catch { return null; }
    }
  }
  return null;
}

export function actionDiagnostic(value) {
  const states = new Set(['not_executed','executed','partially_executed','execution_unknown']);
  const valid = data => data && states.has(data.execution_state);
  if (valid(value.structuredContent)) return value.structuredContent;
  if (!value.isError) return null;
  for (const item of value.content || []) {
    if (item.type !== 'text') continue;
    const match = /^Error (?:executing|calling) tool [^:\n]+:\s*(\{.*\})$/s.exec(item.text);
    if (!match) continue;
    try { const data = JSON.parse(match[1]); if (valid(data) && data.is_error) return data; } catch { /* Keep uncertain errors uncertain. */ }
  }
  return null;
}

export function actionResult(value) {
  const data = actionDiagnostic(value);
  if (data?.is_error) value.isError = true;
  const execution_state = data?.execution_state || (value.isError ? 'execution_unknown' : 'executed');
  const state = { ...data, execution_state, action_not_executed: execution_state === 'not_executed', action_not_retried: true,
    ...(value.isError ? {next_action:data?.next_action || 'Take a fresh snapshot before deciding what remains; do not replay the whole action.'} : {}) };
  value.structuredContent = { ...(value.structuredContent || {}), ...state };
  value.content.push({type:'text',text:'Action execution: '+JSON.stringify(state)});
  return value;
}
export function captureDiagnostic(value) {
  for (const item of value.content || []) {
    if (item.type !== 'text') continue;
    const match = /^Error capturing desktop state: (\{.*\})\. Please try again\.$/s.exec(item.text);
    if (!match) continue;
    try {
      const data = JSON.parse(match[1]);
      if (['WINDOW_NOT_FOUND', 'WINDOW_AMBIGUOUS'].includes(data.code)) return data;
    } catch { /* Keep the original error text. */ }
  }
  return null;
}
