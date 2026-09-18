/**
 * Deferred tool groups: every driver tool stays registered, but only the core
 * set is active at session start. The `computer_use_tools` tool or the
 * `/computer-use-tools` command activates a group on demand.
 *
 * Names are unprefixed driver tool names; the `computer_use_` prefix is
 * applied where they are registered and activated.
 */

export interface ToolGroup {
  readonly summary: string;
  readonly tools: readonly string[];
}

export const CORE_TOOLS: readonly string[] = [
  'list_apps',
  'launch_app',
  'get_window_state',
  'verify_state',
  'click',
  'double_click',
  'right_click',
  'drag',
  'type_text',
  'press_key',
  'hotkey',
  'set_value',
  'scroll',
  'zoom',
];

export const TOOL_GROUPS: Readonly<Record<string, ToolGroup>> = {
  browser: {
    summary: 'CDP browser automation: prepare, navigate, click, type, dialogs, downloads',
    tools: [
      'browser_prepare',
      'browser_navigate',
      'browser_click',
      'browser_type',
      'browser_dialog',
      'browser_set_input_files',
      'browser_download',
      'browser_pointer',
      'get_browser_state',
      'page',
    ],
  },
  recording: {
    summary: 'Record and replay GUI trajectories (video requires ffmpeg)',
    tools: [
      'start_recording',
      'stop_recording',
      'get_recording_state',
      'replay_trajectory',
      'install_ffmpeg',
    ],
  },
  session: {
    summary: 'Escalated sessions for multi-step or higher-privilege automation',
    tools: [
      'start_session',
      'escalate_session',
      'get_session',
      'get_session_state',
      'list_sessions',
      'end_session',
    ],
  },
  cursor: {
    summary: 'Agent cursor overlay: visible pointer, motion style, theme',
    tools: [
      'move_cursor',
      'set_agent_cursor_enabled',
      'set_agent_cursor_motion',
      'set_agent_cursor_theme',
      'get_agent_cursor_state',
    ],
  },
  window: {
    summary: 'Window management: list windows, focus, resize, invoke menus, kill apps',
    tools: ['list_windows', 'bring_to_front', 'set_window_frame', 'invoke_menu', 'kill_app'],
  },
  clipboard: {
    summary: 'Read and write the system clipboard',
    tools: ['clipboard_read', 'clipboard_write'],
  },
  diagnostics: {
    summary: 'Permissions, health report, driver config, display and desktop info',
    tools: [
      'check_permissions',
      'health_report',
      'get_config',
      'set_config',
      'check_for_update',
      'get_desktop_state',
      'get_screen_size',
      'get_cursor_position',
      'get_accessibility_tree',
    ],
  },
};

export const TOOL_GROUP_NAMES: readonly string[] = Object.keys(TOOL_GROUPS);
