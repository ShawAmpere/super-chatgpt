export function waitResult(value) {
  if(value.structuredContent?.status)return value.structuredContent;
  for(const item of value.content||[])if(item.type==='text'){
    try{const parsed=JSON.parse(item.text);if(parsed.status&&'condition_met' in parsed)return parsed;}catch{/* Not a JSON result. */}
  }
  return null;
}
