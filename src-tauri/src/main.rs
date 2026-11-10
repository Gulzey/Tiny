#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{Manager, WindowEvent};

fn sync_activity(window: &tauri::WebviewWindow) {
    let active = window.is_visible().unwrap_or(false)
        && !window.is_minimized().unwrap_or(true)
        && window.is_focused().unwrap_or(false);
    let _ = window.eval(&format!(
        "window.dispatchEvent(new CustomEvent('tiny-native-activity', {{detail: {{active: {active}}}}}));"
    ));
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .on_page_load(|webview, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Finished {
                if let Some(window) = webview.get_webview_window(webview.label()) {
                    sync_activity(&window);
                }
            }
        })
        .on_window_event(|window, event| {
            if matches!(event, WindowEvent::Focused(_) | WindowEvent::Resized(_)) {
                if let Some(webview) = window.get_webview_window(window.label()) {
                    sync_activity(&webview);
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("Tiny could not start its desktop window");
}
