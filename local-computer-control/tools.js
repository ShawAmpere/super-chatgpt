import { z } from 'zod';

const owner = z.string().min(1).max(128).optional();
const point = z.array(z.number().int().min(-100000).max(100000)).length(2);
export const tools = [
  { name: 'get_computer_status', description: 'Report shared Windows desktop readiness and occupancy without disclosing another workflow\'s lease capability. Does not take a screenshot or launch an Agent.', readOnly: true, schema: {} },
  { name: 'acquire_computer_control', description: 'Reserve the shared desktop for one Chat or Agent workflow. Reuse a unique owner_id throughout that workflow. If omitted, returns a random owner_id to keep private and reuse in later calls. Other workflows receive DESKTOP_BUSY. Renew before expiry; release when finished. Short waits are at most 20 seconds. This coordinates desktop actions, not CLI concurrency.', readOnly: false,
    schema: { owner_id: owner, lease_seconds: z.number().int().min(10).max(300).default(60), wait_seconds: z.number().min(0).max(20).default(0) } },
  { name: 'release_computer_control', description: 'Release only this owner_id desktop reservation. Does not stop an Agent, close apps or undo actions.', readOnly: false, schema: { owner_id: owner } },
  { name: 'computer_snapshot', description: 'Inspect Windows after acquiring control. screenshot is fast; elements returns accessibility text and exact label=N mappings; both includes an image. Tree scope=active (default) inspects the foreground window; scope=desktop also includes desktop/taskbar controls and can be slower. For elements/both, window_name selects an exact title first, otherwise a unique partial title; mismatch returns actual candidate titles. region crops image and tree. Returns observation snapshot_id, age and validity. Use original desktop pixels. Refresh after changes; never guess labels.', readOnly: true,
    schema: { owner_id: owner, detail: z.enum(['screenshot', 'elements', 'both']).default('screenshot'), display: z.array(z.number().int().min(0).max(31)).max(32).optional(), region: z.array(z.number().int()).length(4).optional(), scope: z.enum(['active','desktop']).default('active'), window_name: z.string().min(1).max(500).optional() } },
  { name: 'computer_action', description: 'Operate Windows with the same acquired owner_id. Actions: click/type/scroll/move/drag/shortcut/launch/focus/resize/clipboard_get/clipboard_set. Every label needs its originating snapshot_id from elements/both. A background tree target must first be focused and re-observed; occluded label points are refused. loc/from_loc use original desktop pixels. Type needs loc/label or explicitly target=focused for an enabled focused editor. auto pastes literal long/Unicode text, but refuses unsupported clipboard formats before clearing; keys accepts at most 128 characters and leaves clipboard untouched. observe_after returns the next observation in the same call; observe_region crops it. launch accepts a path or a bare PATH program with separate args. focus/resize use exact-first or unique partial window titles. execution_state distinguishes no execution, success, partial and unknown execution; inspect partial/unknown failures, never replay automatically.', readOnly: false,
    schema: { owner_id: owner, action: z.enum(['click','type','scroll','move','drag','shortcut','launch','focus','resize','clipboard_get','clipboard_set']),
      loc: point.optional(), from_loc: point.optional(), label: z.number().int().min(0).optional(),
      target: z.enum(['focused']).optional(), snapshot_id: z.string().uuid().optional(),
      button: z.enum(['left','right','middle']).optional(), clicks: z.number().int().min(0).max(2).optional(),
      text: z.string().max(100000).optional(), clear: z.boolean().optional(), press_enter: z.boolean().optional(),
      input_method: z.enum(['auto','paste','keys']).default('auto'),
      observe_after: z.enum(['none','screenshot','elements','both']).default('none'),
      observe_region: z.array(z.number().int()).length(4).optional(),
      direction: z.enum(['up','down','left','right']).optional(), wheel_times: z.number().int().min(1).max(100).optional(),
      duration: z.number().min(0).max(10).optional(), shortcut: z.string().min(1).max(200).optional(),
      executable: z.string().min(1).optional(), args: z.array(z.string()).max(64).optional(), cwd: z.string().optional(),
      window_name: z.string().min(1).max(500).optional(), window_size: point.optional(), window_loc: point.optional() } },
  { name: 'computer_wait_for', description: 'Wait up to 20 seconds for a window/text/UI element. active_window uses fast Win32 checks and preserves the prior observation if the foreground stays unchanged. Text/element waits inspect accessibility data and invalidate previous label state. Returns condition_met and timed_out: an unmet deadline is a normal result. probe_timeout means inspection failed, not target absence. Requires the same owner_id. Waiting does not create a new valid snapshot.', readOnly: true,
    schema: { owner_id: owner, condition: z.enum(['text_exists','active_window','element_exists','element_enabled','focused_element']), text: z.string().max(1000).optional(), window_name: z.string().max(500).optional(), timeout: z.number().min(0.1).max(20).default(10) } },
];
export const toolByName = new Map(tools.map((tool) => [tool.name, tool]));
export function validateInput(name, input) {
  const tool = toolByName.get(name);
  if (!tool) throw new Error(`Unknown desktop tool: ${name}`);
  const value=z.strictObject(tool.schema).parse(input);
  if(name==='computer_action' && value.target){
    if(value.action!=='type')throw new Error('target=focused is supported only for action=type.');
    if(value.label!==undefined || value.loc!==undefined)throw new Error('Choose one type target: loc/label or target=focused.');
  }
  if(name==='computer_action'&&value.action==='type'){
    if(value.text?.includes('\0'))throw new Error('Text cannot contain NUL characters.');
    if(value.input_method==='keys'&&value.text?.length>128)throw new Error('keys mode accepts at most 128 characters; use auto or paste.');
  }
  return value;
}
