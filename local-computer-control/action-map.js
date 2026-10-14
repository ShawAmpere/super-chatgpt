import { DesktopRequestError } from './desktop-state.js';

export function desktopAction(input) {
  const required = (key) => { if (input[key] === undefined) throw new DesktopRequestError('PARAMETER_REQUIRED', `${key} is required for action=${input.action}`); return input[key]; };
  const target = () => {
    if (input.action === 'type' && input.target === 'focused') return { focused: true };
    if (input.label !== undefined) return { label: input.label };
    if (input.loc !== undefined) return { loc: input.loc };
    throw new DesktopRequestError('TARGET_REQUIRED', `loc is required for action=${input.action} unless an explicit label${input.action === 'type' ? ' or target=focused' : ''} is provided.`,
      { next_action: input.action === 'type' ? 'Use a snapshot label/loc, or target=focused for a verified focused editor.' : 'Use a label/loc from a fresh snapshot.' });
  };
  switch (input.action) {
    case 'click': return ['Click', { ...target(), button: input.button || 'left', clicks: input.clicks ?? 1 }];
    case 'type': return ['Type', { ...target(), text: required('text'), clear: input.clear ?? false, press_enter: input.press_enter ?? false, input_method: input.input_method || 'auto' }];
    case 'scroll': return ['Scroll', { ...(input.label !== undefined ? { label: input.label } : input.loc ? { loc: input.loc } : {}), type: input.direction === 'left' || input.direction === 'right' ? 'horizontal' : 'vertical', direction: input.direction || 'down', wheel_times: input.wheel_times ?? 1 }];
    case 'move': return ['Move', { ...target(), drag: false }];
    case 'drag': return ['Move', { ...target(), drag: true, ...(input.from_loc ? { from_loc: input.from_loc } : {}), duration: input.duration ?? 0.5 }];
    case 'shortcut': return ['Shortcut', { shortcut: required('shortcut') }];
    case 'launch': return ['App', { mode: 'launch_executable', executable: required('executable'), args: input.args || [], ...(input.cwd ? { cwd: input.cwd } : {}) }];
    case 'focus': return ['App', { mode: 'switch', name: required('window_name') }];
    case 'resize': return ['App', { mode: 'resize', ...(input.window_name ? { name: input.window_name } : {}), window_size: required('window_size'), ...(input.window_loc ? { window_loc: input.window_loc } : {}) }];
    case 'clipboard_get': return ['Clipboard', { mode: 'get' }];
    case 'clipboard_set': return ['Clipboard', { mode: 'set', text: required('text') }];
    default: throw new Error(`Unsupported desktop action: ${input.action}`);
  }
}
