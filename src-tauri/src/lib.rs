//! Unacro's native side is deliberately tiny: read a file, write a file safely,
//! pass on files the operating system asks it to open, and print HTML to PDF
//! (for Markdown, see print.rs). Everything else happens in the web UI.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, Emitter, Manager, State};

mod print;

/// Read a whole file and return its bytes without JSON encoding.
#[tauri::command]
fn read_file(path: String) -> Result<Response, String> {
    fs::read(&path)
        .map(Response::new)
        .map_err(|e| format!("{path}: {e}"))
}

/// Write bytes to a file atomically: write a temporary file next to it, flush it
/// to disk, then rename it over the target. A crash mid-save leaves the original intact.
/// The raw request body is the file content; the target path is in the `x-path` header.
#[tauri::command]
fn write_file(request: Request<'_>) -> Result<(), String> {
    let encoded = request
        .headers()
        .get("x-path")
        .ok_or("missing x-path header")?
        .to_str()
        .map_err(|e| e.to_string())?;
    let path = PathBuf::from(percent_decode(encoded)?);
    let InvokeBody::Raw(data) = request.body() else {
        return Err("expected raw bytes".into());
    };
    write_atomic(&path, data).map_err(|e| format!("{}: {e}", path.display()))
}

fn write_atomic(path: &Path, data: &[u8]) -> std::io::Result<()> {
    // Write through symlinks to the real file rather than replacing the link.
    let target = match fs::canonicalize(path) {
        Ok(real) => real,
        Err(_) => path.to_path_buf(),
    };
    let dir = target.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or(Path::new("."));
    let name = target
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "document".into());
    let tmp = dir.join(format!(".{name}.unacro-{}.tmp", std::process::id()));

    let result = (|| {
        let mut file = fs::File::create(&tmp)?;
        file.write_all(data)?;
        file.sync_all()?;
        drop(file);
        // Keep the original file's permissions.
        if let Ok(meta) = fs::metadata(&target) {
            fs::set_permissions(&tmp, meta.permissions())?;
        }
        fs::rename(&tmp, &target)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

fn percent_decode(s: &str) -> Result<String, String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).map_err(|e| e.to_string())?;
            out.push(u8::from_str_radix(hex, 16).map_err(|e| e.to_string())?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|e| e.to_string())
}

// ------------------------------------------------------------------ app data
//
// Unacro keeps its own small files (file history, thumbnails) in the platform's
// app-data folder, e.g. ~/Library/Application Support/dev.unacro.app on macOS or
// ~/.local/share/dev.unacro.app on Linux. Names are relative and can't escape it.

fn valid_data_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != ".." && !part.contains('\\') && !part.contains(':'))
}

fn data_path(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    if !valid_data_name(name) {
        return Err(format!("invalid data file name: {name}"));
    }
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(dir.join(name))
}

/// Read a file from the app-data folder. A missing file returns an empty response.
#[tauri::command]
fn data_read(app: AppHandle, name: String) -> Result<Response, String> {
    let path = data_path(&app, &name)?;
    match fs::read(&path) {
        Ok(bytes) => Ok(Response::new(bytes)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Response::new(Vec::new())),
        Err(e) => Err(format!("{}: {e}", path.display())),
    }
}

/// Write a file in the app-data folder (atomically). Raw body; name in the `x-name` header.
#[tauri::command]
fn data_write(app: AppHandle, request: Request<'_>) -> Result<(), String> {
    let name = request
        .headers()
        .get("x-name")
        .ok_or("missing x-name header")?
        .to_str()
        .map_err(|e| e.to_string())?;
    let path = data_path(&app, &percent_decode(name)?)?;
    let InvokeBody::Raw(data) = request.body() else {
        return Err("expected raw bytes".into());
    };
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    write_atomic(&path, data).map_err(|e| format!("{}: {e}", path.display()))
}

/// Delete a file or folder in the app-data folder. Missing is fine.
#[tauri::command]
fn data_delete(app: AppHandle, name: String) -> Result<(), String> {
    let path = data_path(&app, &name)?;
    let result = if path.is_dir() { fs::remove_dir_all(&path) } else { fs::remove_file(&path) };
    match result {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
        _ => Ok(()),
    }
}

/// A short fingerprint of a file's size and modification time, to notice when it
/// changes on disk (an open Markdown file being edited). Null if it can't be read.
#[tauri::command]
fn file_stamp(path: String) -> Option<String> {
    let meta = fs::metadata(&path).ok()?;
    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    Some(format!("{}-{modified}", meta.len()))
}

/// Which of these files still exist (to grey out moved or deleted files).
#[tauri::command]
fn paths_exist(paths: Vec<String>) -> Vec<bool> {
    paths.iter().map(|p| Path::new(p).is_file()).collect()
}

// ------------------------------------------------------------------ opening files
//
// Files reach Unacro in three ways:
//  - command-line arguments when it starts (`unacro a.pdf b.pdf`, or a double-click
//    on Linux/Windows when Unacro isn't running yet)
//  - a second launch while Unacro is running (double-click on Linux/Windows): the
//    single-instance plugin hands its arguments to the running app, which opens
//    them as tabs, and the second process exits
//  - macOS "open document" events (double-click, Open With, drop on the Dock icon)
//
// The single-instance plugin is deliberately not used on macOS. There, a
// double-clicked file isn't on the command line: it arrives as an event after
// launch. If a second copy of Unacro was started (for example the installed app
// while a development build is running), the plugin would forward its empty
// command line to the first copy and quit before that event arrived, losing the
// file. macOS already routes documents to the running instance of an app.
//
// Files can arrive before the UI has loaded, so they wait in a queue until the UI
// asks for them with `initial_paths`. After that they are sent as "open-files" events.

#[derive(Default)]
struct OpenQueue {
    ui_ready: bool,
    pending: Vec<String>,
}

/// Keep existing files from a list of arguments, resolved against `cwd`.
fn file_args(args: impl IntoIterator<Item = String>, cwd: &Path) -> Vec<String> {
    args.into_iter()
        .filter(|a| !a.starts_with('-'))
        .map(|a| {
            let p = PathBuf::from(&a);
            if p.is_absolute() { p } else { cwd.join(p) }
        })
        .filter_map(|p| fs::canonicalize(p).ok())
        .filter(|p| p.is_file())
        .map(|p| p.to_string_lossy().into_owned())
        .collect()
}

fn focus_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn deliver(app: &AppHandle, paths: Vec<String>) {
    if !paths.is_empty() {
        let queue = app.state::<Mutex<OpenQueue>>();
        let mut q = queue.lock().unwrap();
        if q.ui_ready {
            let _ = app.emit("open-files", paths);
        } else {
            q.pending.extend(paths);
        }
    }
    focus_main(app);
}

/// Files to open at startup: command-line arguments plus anything the OS sent
/// before the UI was ready. From now on, files are sent as events.
#[tauri::command]
fn initial_paths(queue: State<'_, Mutex<OpenQueue>>) -> Vec<String> {
    let cwd = std::env::current_dir().unwrap_or_default();
    let mut paths = file_args(std::env::args().skip(1), &cwd);
    let mut q = queue.lock().unwrap();
    // A reload of the UI must not reopen the command-line files.
    if q.ui_ready {
        paths.clear();
    }
    q.ui_ready = true;
    paths.append(&mut q.pending);
    paths
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();

    // Must be the first plugin registered.
    #[cfg(any(windows, target_os = "linux"))]
    let builder = {
        builder.plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            let paths = file_args(argv.into_iter().skip(1), Path::new(&cwd));
            deliver(app, paths);
        }))
    };

    builder
        .manage(Mutex::new(OpenQueue::default()))
        .manage(print::PrintJobs::default())
        .register_uri_scheme_protocol(print::SCHEME, print::serve)
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            read_file,
            write_file,
            initial_paths,
            data_read,
            data_write,
            data_delete,
            paths_exist,
            file_stamp,
            print::html_to_pdf
        ])
        .build(tauri::generate_context!())
        .expect("error while building Unacro")
        .run(|_app, _event| {
            #[cfg(any(target_os = "macos", target_os = "ios"))]
            if let tauri::RunEvent::Opened { urls } = _event {
                let paths = urls
                    .into_iter()
                    .filter_map(|u| u.to_file_path().ok())
                    .filter(|p| p.is_file())
                    .map(|p| p.to_string_lossy().into_owned())
                    .collect();
                deliver(_app, paths);
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn data_names_stay_inside_the_data_folder() {
        assert!(valid_data_name("history.json"));
        assert!(valid_data_name("thumbs/ab12.jpg"));
        assert!(!valid_data_name("../secrets"));
        assert!(!valid_data_name("thumbs/../../x"));
        assert!(!valid_data_name("/etc/passwd"));
        assert!(!valid_data_name("a\\b"));
        assert!(!valid_data_name("C:x"));
        assert!(!valid_data_name(""));
    }

    #[test]
    fn decodes_paths() {
        assert_eq!(percent_decode("%2Fhome%2Fp%C3%A5%20x.pdf").unwrap(), "/home/på x.pdf");
        assert_eq!(percent_decode("plain").unwrap(), "plain");
    }

    #[test]
    fn file_args_resolves_relative_paths_and_skips_flags() {
        let dir = std::env::temp_dir().join(format!("unacro-args-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("a.pdf"), b"%PDF").unwrap();
        let got = file_args(
            vec!["--flag".into(), "a.pdf".into(), "missing.pdf".into(), "-psn_0_123".into()],
            &dir,
        );
        let want = fs::canonicalize(dir.join("a.pdf")).unwrap().to_string_lossy().into_owned();
        assert_eq!(got, vec![want]);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn atomic_write_replaces_content() {
        let dir = std::env::temp_dir().join(format!("unacro-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let f = dir.join("doc.pdf");
        fs::write(&f, b"old").unwrap();
        write_atomic(&f, b"new content").unwrap();
        assert_eq!(fs::read(&f).unwrap(), b"new content");
        let leftovers: Vec<_> = fs::read_dir(&dir).unwrap().filter_map(|e| e.ok()).collect();
        assert_eq!(leftovers.len(), 1, "no temp files left behind");
        fs::remove_dir_all(&dir).unwrap();
    }
}
