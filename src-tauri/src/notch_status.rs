use objc2::MainThreadMarker;
use objc2_app_kit::{NSScreen, NSWindow, NSWindowCollectionBehavior};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::state::AppState;

const WINDOW_LABEL: &str = "notch-status";
const WINDOW_HEIGHT: f64 = 44.0;
const MIN_WINDOW_WIDTH: f64 = 226.0;
const MAX_WINDOW_WIDTH: f64 = 286.0;
const NOTCH_SIDE_PADDING: f64 = 44.0;

#[derive(Clone, Copy, Debug, PartialEq)]
struct RectMetrics {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct NotchGeometry {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

pub fn setup(app: &mut tauri::App) -> tauri::Result<()> {
    WebviewWindowBuilder::new(
        app,
        WINDOW_LABEL,
        WebviewUrl::App("notch-status.html".into()),
    )
    .title("Codex Pulse 刘海状态")
    .inner_size(MIN_WINDOW_WIDTH, WINDOW_HEIGHT)
    .resizable(false)
    .decorations(false)
    .transparent(true)
    .shadow(false)
    .focused(false)
    .visible(false)
    .always_on_top(true)
    .visible_on_all_workspaces(true)
    .build()?;
    Ok(())
}

pub fn sync_now(app: &AppHandle, enabled: bool) -> Result<bool, String> {
    let window = app
        .get_webview_window(WINDOW_LABEL)
        .ok_or("刘海状态窗口不可用")?;
    let marker = MainThreadMarker::new().ok_or("刘海状态只能在主线程更新")?;
    let geometry = find_notch_geometry(marker);
    if let Some(geometry) = geometry {
        configure_window(&window, geometry)?;
        if !enabled {
            window.hide().map_err(|error| error.to_string())?;
        }
        Ok(true)
    } else {
        window.hide().map_err(|error| error.to_string())?;
        Ok(false)
    }
}

pub fn show(app: &AppHandle) -> Result<(), String> {
    app.get_webview_window(WINDOW_LABEL)
        .ok_or("刘海状态窗口不可用")?
        .show()
        .map_err(|error| error.to_string())
}

pub fn hide(app: &AppHandle) -> Result<(), String> {
    app.get_webview_window(WINDOW_LABEL)
        .ok_or("刘海状态窗口不可用")?
        .hide()
        .map_err(|error| error.to_string())
}

pub fn schedule_sync(app: &AppHandle, enabled: bool) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let supported = sync_now(&handle, enabled).unwrap_or(false);
        if let Some(state) = handle.try_state::<AppState>() {
            state.set_notch_status_supported(supported);
        }
    });
}

fn find_notch_geometry(marker: MainThreadMarker) -> Option<NotchGeometry> {
    if let Some(screen) = NSScreen::mainScreen(marker)
        && let Some(geometry) = geometry_for_screen(&screen)
    {
        return Some(geometry);
    }
    NSScreen::screens(marker)
        .iter()
        .find_map(|screen| geometry_for_screen(&screen))
}

fn geometry_for_screen(screen: &NSScreen) -> Option<NotchGeometry> {
    let frame = screen.frame();
    let left = screen.auxiliaryTopLeftArea();
    let right = screen.auxiliaryTopRightArea();
    calculate_geometry(
        RectMetrics {
            x: frame.origin.x,
            y: frame.origin.y,
            width: frame.size.width,
            height: frame.size.height,
        },
        RectMetrics {
            x: left.origin.x,
            y: left.origin.y,
            width: left.size.width,
            height: left.size.height,
        },
        RectMetrics {
            x: right.origin.x,
            y: right.origin.y,
            width: right.size.width,
            height: right.size.height,
        },
        screen.safeAreaInsets().top,
    )
}

fn calculate_geometry(
    frame: RectMetrics,
    left: RectMetrics,
    right: RectMetrics,
    top_inset: f64,
) -> Option<NotchGeometry> {
    if top_inset <= 0.0 || left.width <= 0.0 || right.width <= 0.0 {
        return None;
    }
    let notch_left = left.x + left.width;
    let notch_right = right.x;
    let notch_width = notch_right - notch_left;
    if notch_width < 80.0 || notch_width > frame.width * 0.45 {
        return None;
    }
    let width = (notch_width + NOTCH_SIDE_PADDING).clamp(MIN_WINDOW_WIDTH, MAX_WINDOW_WIDTH);
    let notch_midpoint = notch_left + notch_width / 2.0;
    Some(NotchGeometry {
        x: notch_midpoint - width / 2.0,
        y: frame.y + frame.height - top_inset - WINDOW_HEIGHT + 1.0,
        width,
        height: WINDOW_HEIGHT,
    })
}

fn configure_window(window: &WebviewWindow, geometry: NotchGeometry) -> Result<(), String> {
    let pointer = window.ns_window().map_err(|error| error.to_string())?;
    let native_window: &NSWindow = unsafe { &*pointer.cast() };
    let mut frame = native_window.frame();
    frame.origin.x = geometry.x;
    frame.origin.y = geometry.y;
    frame.size.width = geometry.width;
    frame.size.height = geometry.height;
    native_window.setFrame_display(frame, true);
    native_window.setCollectionBehavior(
        native_window.collectionBehavior()
            | NSWindowCollectionBehavior::CanJoinAllSpaces
            | NSWindowCollectionBehavior::FullScreenAuxiliary
            | NSWindowCollectionBehavior::IgnoresCycle,
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn centers_status_window_below_notch() {
        let geometry = calculate_geometry(
            RectMetrics {
                x: 0.0,
                y: 0.0,
                width: 1512.0,
                height: 982.0,
            },
            RectMetrics {
                x: 0.0,
                y: 950.0,
                width: 635.0,
                height: 32.0,
            },
            RectMetrics {
                x: 877.0,
                y: 950.0,
                width: 635.0,
                height: 32.0,
            },
            32.0,
        )
        .unwrap();
        assert_eq!(geometry.width, 286.0);
        assert_eq!(geometry.height, 44.0);
        assert_eq!(geometry.x, 613.0);
        assert_eq!(geometry.y, 907.0);
    }

    #[test]
    fn rejects_screen_without_auxiliary_notch_areas() {
        let frame = RectMetrics {
            x: 0.0,
            y: 0.0,
            width: 1920.0,
            height: 1080.0,
        };
        let empty = RectMetrics {
            x: 0.0,
            y: 0.0,
            width: 0.0,
            height: 0.0,
        };
        assert_eq!(calculate_geometry(frame, empty, empty, 0.0), None);
    }
}
