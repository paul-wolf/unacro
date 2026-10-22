//! Unacro's native side is deliberately tiny: read a file, write a file safely,
//! and report which files were passed on the command line. Everything else
//! happens in the web UI.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use tauri::ipc::{InvokeBody, Request, Response};

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

/// PDF files given on the command line, e.g. `unacro a.pdf b.pdf`.
#[tauri::command]
fn initial_paths() -> Vec<String> {
    std::env::args()
        .skip(1)
        .filter(|a| !a.starts_with('-'))
        .filter_map(|a| fs::canonicalize(&a).ok())
        .filter(|p| p.is_file())
        .map(|p| p.to_string_lossy().into_owned())
        .collect()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![read_file, write_file, initial_paths])
        .run(tauri::generate_context!())
        .expect("error while running Unacro");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_paths() {
        assert_eq!(percent_decode("%2Fhome%2Fp%C3%A5%20x.pdf").unwrap(), "/home/på x.pdf");
        assert_eq!(percent_decode("plain").unwrap(), "plain");
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
